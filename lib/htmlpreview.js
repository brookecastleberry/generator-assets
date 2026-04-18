/*
 * Copyright (c) 2026 Adobe Systems Incorporated. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

(function () {
    "use strict";

    var events = require("events"),
        path = require("path"),
        url = require("url"),
        util = require("util");

    var Q = require("q");

    /**
     * Default relative path, under the FileManager base directory, where the
     * generated HTML preview is written.
     * @type {string}
     */
    var DEFAULT_PREVIEW_PATH = path.join(".html-preview", "index.html");

    /**
     * Default bound on the number of times {@link HtmlPreviewManager#review}
     * may flip to rejection before the workflow gives up and emits
     * `max-retries-exceeded`.
     * @type {number}
     */
    var DEFAULT_MAX_RETRIES = 3;

    /**
     * Escape the given string so that it can be safely interpolated into HTML
     * text content or a double-quoted attribute.
     *
     * @private
     * @param {*} value
     * @return {string}
     */
    function _escapeHtml(value) {
        var s = value === null || value === undefined ? "" : String(value);
        return s
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    /**
     * Workflow states, corresponding 1:1 with the nodes of the Miro
     * "HTML Preview Branch" flowchart.
     *
     * @type {object}
     */
    var STATE = {
        IDLE: "idle",
        GENERATING: "generating",
        STORED: "stored",
        SHARED: "shared",
        AWAITING_REVIEW: "awaiting-review",
        READY_FOR_RELEASE: "ready-for-release",
        REGENERATING: "regenerating",
        VERIFIED_OUTPUT: "verified-output",
        EXHAUSTED: "exhausted"
    };

    /**
     * Implements the "HTML Preview Branch" workflow from the Generator-Assets
     * Miro board.
     *
     * The flowchart has the following nodes and transitions:
     *
     *   Generate HTML preview --save--> Store preview artifact
     *   Store preview artifact --provide--> Open or share preview link
     *   Open or share preview link --review--> Preview accepted?
     *   Preview accepted? --yes--> Mark ready for release
     *   Preview accepted? --no--> Regenerate asset
     *   Regenerate asset --retry--> Generate HTML preview      (loop)
     *   Mark ready for release / Regenerate loop --next step--> Verified output
     *
     * This module is implemented as a small event-driven state machine. Each
     * node of the flowchart maps to either a method on the manager or an
     * emitted event, so a host application (such as the asset generator
     * plug-in or a test harness) can drive the workflow end-to-end while
     * plugging in its own asset regeneration logic.
     *
     * Events emitted:
     * - `preview-generated` `({ html, components })`
     * - `preview-stored` `({ absolutePath, relativePath })`
     * - `preview-shared` `({ url, absolutePath })`
     * - `review-requested` `({ url, absolutePath, attempt })`
     * - `ready-for-release` `({ absolutePath, attempt })`
     * - `regenerate-requested` `({ attempt, attemptsRemaining })`
     * - `verified-output` `({ absolutePath, attempt })`
     * - `max-retries-exceeded` `({ attempt, maxRetries })`
     * - `error` `(err)` emitted whenever a filesystem or workflow error occurs
     *
     * @constructor
     * @param {object} fileManager An object exposing
     *      `writeFileWithin(relativePath, data)` returning a promise, and a
     *      `basePath` property (see {@link FileManager}).
     * @param {object=} config Optional configuration.
     * @param {object=} logger Optional logger (Generator-style).
     */
    function HtmlPreviewManager(fileManager, config, logger) {
        events.EventEmitter.call(this);

        this._fileManager = fileManager;
        this._config = config || {};
        this._logger = logger || {
            info: function () {},
            warn: function () {},
            error: function () {},
            debug: function () {}
        };

        this._state = STATE.IDLE;
        this._attempts = 0;
        this._lastComponents = null;
        this._lastAbsolutePath = null;
        this._lastRelativePath = null;
        this._lastUrl = null;
        this._lastHtml = null;

        this._previewPath = this._config["html-preview-path"] || DEFAULT_PREVIEW_PATH;

        var rawMax = this._config["html-preview-max-retries"];
        var parsedMax = parseInt(rawMax, 10);
        if (rawMax === undefined || rawMax === null || isNaN(parsedMax) || parsedMax < 0) {
            parsedMax = DEFAULT_MAX_RETRIES;
        }
        this._maxRetries = parsedMax;
    }

    util.inherits(HtmlPreviewManager, events.EventEmitter);

    /**
     * Valid workflow states. Exposed as a static property for consumer
     * convenience and for test assertions.
     *
     * @type {object}
     */
    HtmlPreviewManager.STATE = STATE;

    Object.defineProperties(HtmlPreviewManager.prototype, {
        "state": {
            get: function () { return this._state; }
        },
        "attempts": {
            get: function () { return this._attempts; }
        },
        "maxRetries": {
            get: function () { return this._maxRetries; }
        },
        "previewPath": {
            get: function () { return this._previewPath; }
        },
        "lastUrl": {
            get: function () { return this._lastUrl; }
        },
        "lastAbsolutePath": {
            get: function () { return this._lastAbsolutePath; }
        },
        "lastHtml": {
            get: function () { return this._lastHtml; }
        }
    });

    /**
     * Build the HTML markup for the preview index given a list of asset
     * components.
     *
     * @private
     * @param {Array.<object>} components Components to list in the preview.
     * @return {string} HTML document source.
     */
    HtmlPreviewManager.prototype._buildHtml = function (components) {
        var rows = (components || []).map(function (component, index) {
            var assetPath = component && component.assetPath ? component.assetPath : "";
            var name = component && component.name ? component.name : assetPath;
            var escapedPath = _escapeHtml(assetPath);
            var escapedName = _escapeHtml(name);
            return "        <li class=\"asset\" data-index=\"" + index + "\">" +
                "<a href=\"" + escapedPath + "\">" +
                "<img src=\"" + escapedPath + "\" alt=\"" + escapedName + "\">" +
                "<span class=\"name\">" + escapedName + "</span>" +
                "</a></li>";
        }).join("\n");

        var title = _escapeHtml(this._config["html-preview-title"] || "Generator Assets Preview");
        var generatedAt = _escapeHtml(new Date().toISOString());
        var count = (components || []).length;

        return [
            "<!DOCTYPE html>",
            "<html lang=\"en\">",
            "<head>",
            "    <meta charset=\"utf-8\">",
            "    <title>" + title + "</title>",
            "    <style>",
            "        body { font-family: -apple-system, sans-serif; margin: 2em; color: #222; }",
            "        h1 { margin-bottom: 0.25em; }",
            "        .meta { color: #666; font-size: 0.9em; margin-bottom: 1.5em; }",
            "        ul.assets { list-style: none; padding: 0; " +
                "display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 1em; }",
            "        .asset a { display: block; text-decoration: none; color: inherit; " +
                "border: 1px solid #ddd; border-radius: 6px; padding: 0.5em; background: #fafafa; }",
            "        .asset img { max-width: 100%; height: auto; display: block; }",
            "        .asset .name { display: block; margin-top: 0.5em; font-size: 0.85em; " +
                "word-break: break-all; }",
            "        .empty { color: #999; font-style: italic; }",
            "    </style>",
            "</head>",
            "<body>",
            "    <h1>" + title + "</h1>",
            "    <p class=\"meta\">Generated " + generatedAt + " &middot; " + count + " asset(s)</p>",
            count > 0 ?
                "    <ul class=\"assets\">\n" + rows + "\n    </ul>" :
                "    <p class=\"empty\">No assets to preview.</p>",
            "</body>",
            "</html>",
            ""
        ].join("\n");
    };

    /**
     * Flowchart node: **Generate HTML preview**.
     *
     * Builds the HTML markup describing the current set of asset components,
     * then chains into {@link HtmlPreviewManager#store} and
     * {@link HtmlPreviewManager#share}. On failure the workflow stays in its
     * previous state and an `error` event is emitted.
     *
     * @param {Array.<object>} components Asset components to preview.
     * @return {Promise.<object>} Resolves with `{ url, absolutePath, html }`.
     */
    HtmlPreviewManager.prototype.generate = function (components) {
        var self = this;

        if (this._state === STATE.GENERATING || this._state === STATE.REGENERATING) {
            return Q.reject(new Error("HTML preview generation already in progress"));
        }

        var isRetry = this._attempts > 0;
        this._state = isRetry ? STATE.REGENERATING : STATE.GENERATING;
        this._attempts += 1;
        this._lastComponents = (components || []).slice();

        var html;
        try {
            html = this._buildHtml(this._lastComponents);
        } catch (ex) {
            this._state = STATE.IDLE;
            this.emit("error", ex);
            return Q.reject(ex);
        }
        this._lastHtml = html;
        this._logger.debug("HTML preview generated (%d components, attempt %d)",
            this._lastComponents.length, this._attempts);
        this.emit("preview-generated", { html: html, components: this._lastComponents });

        return this.store(html).then(function (stored) {
            return self.share(stored.absolutePath, stored.relativePath);
        });
    };

    /**
     * Flowchart node: **Store preview artifact**.
     *
     * Writes the generated HTML to the location configured by
     * `html-preview-path` (relative to the FileManager base directory).
     *
     * @param {string} html HTML document source to store.
     * @return {Promise.<object>} Resolves with `{ absolutePath, relativePath }`.
     */
    HtmlPreviewManager.prototype.store = function (html) {
        var self = this;
        var basePath = this._fileManager && this._fileManager.basePath;
        var relativePath = this._previewPath;

        if (!basePath) {
            var err = new Error("Cannot store HTML preview: FileManager has no base path");
            this.emit("error", err);
            return Q.reject(err);
        }

        var absolutePath = path.resolve(basePath, relativePath);

        return Q.when(this._fileManager.writeFileWithin(relativePath, html))
            .then(function () {
                self._lastAbsolutePath = absolutePath;
                self._lastRelativePath = relativePath;
                self._state = STATE.STORED;
                self._logger.info("HTML preview stored: %s", absolutePath);
                var payload = { absolutePath: absolutePath, relativePath: relativePath };
                self.emit("preview-stored", payload);
                return payload;
            })
            .fail(function (err) {
                self.emit("error", err);
                throw err;
            });
    };

    /**
     * Flowchart node: **Open or share preview link**.
     *
     * Converts the stored artifact's absolute path into a `file://` URL (or
     * honours `html-preview-base-url` if configured) and emits
     * `preview-shared` followed by `review-requested`.
     *
     * @param {string} absolutePath Absolute path to the stored artifact.
     * @param {string=} relativePath Relative path, for logging only.
     * @return {Promise.<object>} Resolves with `{ url, absolutePath }`.
     */
    HtmlPreviewManager.prototype.share = function (absolutePath, relativePath) {
        var previewUrl;
        var baseUrl = this._config["html-preview-base-url"];
        if (baseUrl) {
            previewUrl = baseUrl.replace(/\/+$/, "") + "/" +
                (relativePath || path.basename(absolutePath)).split(path.sep).join("/");
        } else {
            previewUrl = url.format({
                protocol: "file",
                slashes: true,
                pathname: absolutePath
            });
        }

        this._lastUrl = previewUrl;
        this._state = STATE.SHARED;
        this._logger.info("HTML preview shareable at %s", previewUrl);
        this.emit("preview-shared", { url: previewUrl, absolutePath: absolutePath });

        this._state = STATE.AWAITING_REVIEW;
        this.emit("review-requested", {
            url: previewUrl,
            absolutePath: absolutePath,
            attempt: this._attempts
        });

        return Q.resolve({ url: previewUrl, absolutePath: absolutePath });
    };


    /**
     * Flowchart decision: **Preview accepted?**
     *
     * On the YES branch, transitions through `Mark ready for release` to
     * `Verified output` and emits the corresponding events. On the NO branch,
     * emits `regenerate-requested` so a host can regenerate the underlying
     * assets, or `max-retries-exceeded` when the attempt budget is spent.
     *
     * @param {boolean} accepted Whether the reviewer accepted the preview.
     * @return {string} The post-review workflow state.
     */
    HtmlPreviewManager.prototype.review = function (accepted) {
        if (this._state !== STATE.AWAITING_REVIEW &&
            this._state !== STATE.SHARED &&
            this._state !== STATE.STORED) {
            var err = new Error("Cannot review preview from state: " + this._state);
            this.emit("error", err);
            throw err;
        }

        if (accepted) {
            this._state = STATE.READY_FOR_RELEASE;
            this._logger.info("HTML preview accepted on attempt %d: %s",
                this._attempts, this._lastAbsolutePath);
            this.emit("ready-for-release", {
                absolutePath: this._lastAbsolutePath,
                attempt: this._attempts
            });

            this._state = STATE.VERIFIED_OUTPUT;
            this.emit("verified-output", {
                absolutePath: this._lastAbsolutePath,
                attempt: this._attempts
            });
            return this._state;
        }

        var attemptsRemaining = this._maxRetries - (this._attempts - 1);
        if (attemptsRemaining <= 0) {
            this._state = STATE.EXHAUSTED;
            this._logger.warn("HTML preview retries exhausted after attempt %d (max=%d)",
                this._attempts, this._maxRetries);
            this.emit("max-retries-exceeded", {
                attempt: this._attempts,
                maxRetries: this._maxRetries
            });
            return this._state;
        }

        this._state = STATE.REGENERATING;
        this._logger.info(
            "HTML preview rejected on attempt %d; requesting regeneration (%d attempts remaining)",
            this._attempts,
            attemptsRemaining
        );
        this.emit("regenerate-requested", {
            attempt: this._attempts,
            attemptsRemaining: attemptsRemaining
        });
        return this._state;
    };

    /**
     * Flowchart node: **Regenerate asset** (+ retry arrow).
     *
     * Rebuilds the preview after asset regeneration. When called without
     * arguments the previously-rendered component list is reused.
     *
     * @param {Array.<object>=} components Optional refreshed component list.
     * @return {Promise.<object>} Resolves with the new `{ url, absolutePath }`.
     */
    HtmlPreviewManager.prototype.regenerate = function (components) {
        if (this._state !== STATE.REGENERATING) {
            return Q.reject(new Error("Cannot regenerate from state: " + this._state));
        }
        this._state = STATE.IDLE;
        var nextComponents = components || this._lastComponents || [];
        return this.generate(nextComponents);
    };

    /**
     * Reset the workflow to its initial state. Useful after a terminal
     * transition or between documents.
     */
    HtmlPreviewManager.prototype.reset = function () {
        this._state = STATE.IDLE;
        this._attempts = 0;
        this._lastComponents = null;
        this._lastAbsolutePath = null;
        this._lastRelativePath = null;
        this._lastUrl = null;
        this._lastHtml = null;
    };

    module.exports = HtmlPreviewManager;
    module.exports.STATE = STATE;
}());
