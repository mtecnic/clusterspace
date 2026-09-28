# Third-party notices

ClusterSpace is [MIT licensed](LICENSE). It bundles and depends on the third-party software
below, each under its own licence. Credit for the terminal emulation, PTY handling and
rendering that make this app possible belongs to these projects.

## Redistributed in this repository

`resources/remote-client/vendor/` contains prebuilt copies of xterm.js assets, served to
the browser by the remote-web-access feature. They are **not** ClusterSpace code.

| File | Project | Version | Licence |
|---|---|---|---|
| `xterm.js` | [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`) | 5.5.0 | MIT |
| `xterm.css` | [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`) | 5.5.0 | MIT |
| `addon-fit.js` | [xterm.js fit addon](https://github.com/xtermjs/xterm.js) (`@xterm/addon-fit`) | 0.10.0 | MIT |

The `xterm.js` and `addon-fit.js` files are minified production bundles; minification
stripped their licence banners, so the required notice is reproduced in full below and in
[`resources/remote-client/vendor/LICENSE`](resources/remote-client/vendor/LICENSE).
`xterm.css` retains its original header.

### xterm.js — MIT

```
Copyright (c) 2017-2022, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair, Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/term.js)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Principal runtime dependencies

Installed via npm rather than redistributed here, but the work this app is built on:

| Project | Licence | What it does for ClusterSpace |
|---|---|---|
| [xterm.js](https://github.com/xtermjs/xterm.js) — `@xterm/xterm` and the `addon-fit`, `addon-search`, `addon-web-links`, `addon-webgl` addons | MIT | Every terminal pane. Full-colour, WebGL-rendered, bracketed-paste-aware terminal emulation. |
| [node-pty](https://github.com/microsoft/node-pty) (Microsoft) | MIT | Spawning and managing the pseudo-terminals behind each pane. |
| [Electron](https://github.com/electron/electron) | MIT | Application shell and the Chromium webviews used for browser panes. |
| [React](https://github.com/facebook/react) | MIT | Renderer UI. |
| [ws](https://github.com/websockets/ws) | MIT | WebSocket transport for remote web access. |
| [electron-store](https://github.com/sindresorhus/electron-store) | MIT | Persisted settings and workspace state. |
| [tmux](https://github.com/tmux/tmux) | ISC | Not bundled — invoked on the remote host. Everything that makes SSH panes survive disconnects is tmux doing the work. |

Licence texts for npm dependencies are installed alongside them under `node_modules/`, and
are included in packaged builds by electron-builder.
