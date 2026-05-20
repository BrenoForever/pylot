import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

// Reuse encoder to avoid allocation per keystroke
const textEncoder = new TextEncoder();

export interface TerminalTabHandle {
  focus: () => void;
  fit: () => void;
}

interface Props {
  ptyId: string;
  cwd: string | null;
  agent?: string;
  agentArgs?: string[];
  visible: boolean;
  onExit?: () => void;
  onOutput?: () => void;
}

export const TerminalTab = forwardRef<TerminalTabHandle, Props>(
  function TerminalTab({ ptyId, cwd, agent, agentArgs, visible, onExit, onOutput }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const spawnedRef = useRef(false);
    const disposedRef = useRef(false);
    const pendingDataRef = useRef<Uint8Array[]>([]);
    const rafIdRef = useRef<number | null>(null);
    const spawnTimeRef = useRef<number>(0);
    const respawnCountRef = useRef<number>(0);
    const onExitRef = useRef(onExit);
    const onOutputRef = useRef(onOutput);

    // Batched write buffer for input → PTY
    const pendingWriteRef = useRef<number[]>([]);
    const writeRafRef = useRef<number | null>(null);

    // Throttle onOutput notifications (at most once per 150ms)
    const lastOutputNotifyRef = useRef<number>(0);

    // Track if user has scrolled up (disable auto-scroll when they have)
    const userScrolledRef = useRef(false);

    onExitRef.current = onExit;
    onOutputRef.current = onOutput;

    useImperativeHandle(ref, () => ({
      focus: () => termRef.current?.focus(),
      fit: () => fitAddonRef.current?.fit(),
    }));

    // Single effect: create terminal + PTY once, never re-run
    useEffect(() => {
      if (!containerRef.current) return;
      disposedRef.current = false;

      const term = new XTerminal({
        theme: {
          background: "#1e1e2e",
          foreground: "#cdd6f4",
          cursor: "#f5e0dc",
          cursorAccent: "#1e1e2e",
          selectionBackground: "rgba(137, 180, 250, 0.3)",
          selectionForeground: "#cdd6f4",
          selectionInactiveBackground: "rgba(69, 71, 90, 0.5)",
          black: "#45475a",
          red: "#f38ba8",
          green: "#a6e3a1",
          yellow: "#f9e2af",
          blue: "#89b4fa",
          magenta: "#cba6f7",
          cyan: "#94e2d5",
          white: "#bac2de",
          brightBlack: "#585b70",
          brightRed: "#f38ba8",
          brightGreen: "#a6e3a1",
          brightYellow: "#f9e2af",
          brightBlue: "#89b4fa",
          brightMagenta: "#cba6f7",
          brightCyan: "#94e2d5",
          brightWhite: "#a6adc8",
        },
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', monospace",
        fontSize: 13,
        fontWeight: "400",
        fontWeightBold: "600",
        lineHeight: 1.35,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: "bar",
        cursorWidth: 2,
        scrollback: 5000,
        allowProposedApi: true,
        macOptionIsMeta: true,
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: true,
        drawBoldTextInBrightColors: true,
        minimumContrastRatio: 1,
        tabStopWidth: 8,
        scrollOnUserInput: true,
        altClickMovesCursor: true,
        convertEol: false,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank")));
      const unicode11Addon = new Unicode11Addon();
      term.loadAddon(unicode11Addon);
      term.unicode.activeVersion = "11";

      term.open(containerRef.current);

      // Load WebGL renderer for much faster rendering
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => webglAddon.dispose());
        term.loadAddon(webglAddon);
      } catch {
        // WebGL not available, fall back to canvas renderer
      }

      fitAddon.fit();

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Track user scroll: if user scrolls up, stop auto-scrolling
      const viewportEl = containerRef.current.querySelector(".xterm-viewport");
      if (viewportEl) {
        viewportEl.addEventListener("wheel", (e: Event) => {
          const we = e as WheelEvent;
          if (we.deltaY < 0) {
            userScrolledRef.current = true;
          }
        });
      }
      // When user scrolls to bottom, re-enable auto-scroll
      term.onScroll(() => {
        const buffer = term.buffer.active;
        const atBottom = buffer.viewportY >= buffer.baseY;
        if (atBottom) {
          userScrolledRef.current = false;
        }
      });

      // PTY output listener — receives base64 encoded data, batched via RAF
      const unlisteners: (() => void)[] = [];

      const setupPty = async () => {
        if (spawnedRef.current) return;
        spawnedRef.current = true;

        // Register output listener BEFORE spawn so we don't miss data
        const unlistenOutput = await listen<string>(
          `pty-output-${ptyId}`,
          (event) => {
            if (disposedRef.current) return;
            // Decode base64 to Uint8Array
            const binaryStr = atob(event.payload);
            const data = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
              data[i] = binaryStr.charCodeAt(i);
            }
            pendingDataRef.current.push(data);

            // Throttled notification to parent about output activity
            const now = performance.now();
            if (now - lastOutputNotifyRef.current > 150) {
              lastOutputNotifyRef.current = now;
              onOutputRef.current?.();
            }

            if (rafIdRef.current === null) {
              rafIdRef.current = requestAnimationFrame(() => {
                const chunks = pendingDataRef.current;
                pendingDataRef.current = [];
                rafIdRef.current = null;
                if (disposedRef.current || chunks.length === 0) return;

                if (chunks.length === 1) {
                  term.write(chunks[0]);
                } else {
                  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
                  const merged = new Uint8Array(totalLen);
                  let offset = 0;
                  for (const chunk of chunks) {
                    merged.set(chunk, offset);
                    offset += chunk.length;
                  }
                  term.write(merged);
                }

                // Auto-scroll to bottom unless user scrolled up
                if (!userScrolledRef.current) {
                  term.scrollToBottom();
                }
              });
            }
          }
        );
        unlisteners.push(unlistenOutput);

        // Spawn the PTY process
        spawnTimeRef.current = Date.now();
        try {
          if (agent) {
            await invoke("spawn_agent_pty", {
              id: ptyId,
              agent,
              args: agentArgs || [],
              cwd: cwd,
            });
          } else {
            await invoke("spawn_pty", { id: ptyId, cwd: cwd });
          }
        } catch (err) {
          term.writeln(`\x1b[31mFailed to spawn: ${err}\x1b[0m`);
          return;
        }

        if (disposedRef.current) return;

        // Register exit listener AFTER spawn completes
        const unlistenExit = await listen<void>(`pty-exit-${ptyId}`, async () => {
          if (disposedRef.current) return;

          const uptime = Date.now() - spawnTimeRef.current;
          respawnCountRef.current++;
          onExitRef.current?.();

          if (uptime < 2000 || respawnCountRef.current > 3) {
            term.writeln("");
            term.writeln(
              "\x1b[38;5;245m[Process exited. Press any key to restart.]\x1b[0m"
            );
            const disposable = term.onData(async () => {
              disposable.dispose();
              if (disposedRef.current) return;
              respawnCountRef.current = 0;
              spawnTimeRef.current = Date.now();
              term.clear();
              try {
                await invoke("close_pty", { id: ptyId }).catch(() => {});
                await invoke("spawn_pty", { id: ptyId, cwd: cwd });
              } catch (err) {
                term.writeln(`\x1b[31mFailed to restart: ${err}\x1b[0m`);
              }
            });
            return;
          }

          // Auto-respawn
          term.writeln("\r\n\x1b[38;5;245m[Restarting...]\x1b[0m\r\n");
          try {
            await invoke("close_pty", { id: ptyId }).catch(() => {});
            spawnTimeRef.current = Date.now();
            await invoke("spawn_pty", { id: ptyId, cwd: cwd });
          } catch (err) {
            term.writeln(`\x1b[31mFailed to restart: ${err}\x1b[0m`);
          }
        });
        unlisteners.push(unlistenExit);
      };

      setupPty();

      // Batched write: group keystrokes within a single animation frame
      const flushWrite = () => {
        writeRafRef.current = null;
        if (disposedRef.current || pendingWriteRef.current.length === 0) return;
        const bytes = pendingWriteRef.current;
        pendingWriteRef.current = [];
        // Encode as base64 for efficient IPC
        const b64 = btoa(String.fromCharCode(...bytes));
        invoke("write_pty", { id: ptyId, data: b64 }).catch(() => {});
      };

      // User input → PTY (batched via microtask for minimal latency)
      // Custom key handling: Ctrl+Backspace / Option+Backspace → word delete
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;

        // Ctrl+Backspace → send \x17 (Ctrl+W = backward kill word)
        if (ev.key === "Backspace" && ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          const encoded = textEncoder.encode("\x17");
          for (let i = 0; i < encoded.length; i++) {
            pendingWriteRef.current.push(encoded[i]);
          }
          if (writeRafRef.current === null) {
            writeRafRef.current = requestAnimationFrame(flushWrite);
          }
          return false;
        }

        // Ctrl+Delete → send \x1b[3;5~ (forward kill word in many shells)
        if (ev.key === "Delete" && ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          const seq = "\x1b[3;5~";
          const encoded = textEncoder.encode(seq);
          for (let i = 0; i < encoded.length; i++) {
            pendingWriteRef.current.push(encoded[i]);
          }
          if (writeRafRef.current === null) {
            writeRafRef.current = requestAnimationFrame(flushWrite);
          }
          return false;
        }

        // Option+Backspace → send \x1b\x7f (ESC DEL = backward kill word)
        if (ev.key === "Backspace" && ev.altKey && !ev.ctrlKey && !ev.metaKey) {
          const seq = "\x1b\x7f";
          const encoded = textEncoder.encode(seq);
          for (let i = 0; i < encoded.length; i++) {
            pendingWriteRef.current.push(encoded[i]);
          }
          if (writeRafRef.current === null) {
            writeRafRef.current = requestAnimationFrame(flushWrite);
          }
          return false;
        }

        // Option+Delete → send \x1b[3~ (ESC + Delete = forward kill word)
        if (ev.key === "Delete" && ev.altKey && !ev.ctrlKey && !ev.metaKey) {
          const seq = "\x1bd";
          const encoded = textEncoder.encode(seq);
          for (let i = 0; i < encoded.length; i++) {
            pendingWriteRef.current.push(encoded[i]);
          }
          if (writeRafRef.current === null) {
            writeRafRef.current = requestAnimationFrame(flushWrite);
          }
          return false;
        }

        // Option+Left → send \x1bb (ESC b = move word left)
        if (ev.key === "ArrowLeft" && ev.altKey && !ev.ctrlKey && !ev.metaKey) {
          const seq = "\x1bb";
          const encoded = textEncoder.encode(seq);
          for (let i = 0; i < encoded.length; i++) {
            pendingWriteRef.current.push(encoded[i]);
          }
          if (writeRafRef.current === null) {
            writeRafRef.current = requestAnimationFrame(flushWrite);
          }
          return false;
        }

        // Option+Right → send \x1bf (ESC f = move word right)
        if (ev.key === "ArrowRight" && ev.altKey && !ev.ctrlKey && !ev.metaKey) {
          const seq = "\x1bf";
          const encoded = textEncoder.encode(seq);
          for (let i = 0; i < encoded.length; i++) {
            pendingWriteRef.current.push(encoded[i]);
          }
          if (writeRafRef.current === null) {
            writeRafRef.current = requestAnimationFrame(flushWrite);
          }
          return false;
        }

        return true;
      });

      term.onData((data) => {
        if (disposedRef.current) return;
        const encoded = textEncoder.encode(data);
        for (let i = 0; i < encoded.length; i++) {
          pendingWriteRef.current.push(encoded[i]);
        }
        if (writeRafRef.current === null) {
          writeRafRef.current = requestAnimationFrame(flushWrite);
        }
      });

      term.onBinary((data) => {
        if (disposedRef.current) return;
        for (let i = 0; i < data.length; i++) {
          pendingWriteRef.current.push(data.charCodeAt(i));
        }
        if (writeRafRef.current === null) {
          writeRafRef.current = requestAnimationFrame(flushWrite);
        }
      });

      // Resize → PTY
      term.onResize(({ rows, cols }) => {
        if (disposedRef.current) return;
        invoke("resize_pty", { id: ptyId, rows, cols }).catch(() => {});
      });

      // Initial resize
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        invoke("resize_pty", { id: ptyId, rows: dims.rows, cols: dims.cols }).catch(() => {});
      }

      // ResizeObserver for container size changes (debounced 100ms)
      let resizeTimeout: ReturnType<typeof setTimeout>;
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => fitAddon.fit(), 100);
      });
      observer.observe(containerRef.current);

      // Focus on click
      const el = containerRef.current;
      const handleClick = () => term.focus();
      el.addEventListener("click", handleClick);

      return () => {
        disposedRef.current = true;
        clearTimeout(resizeTimeout);
        if (writeRafRef.current !== null) cancelAnimationFrame(writeRafRef.current);
        if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
        observer.disconnect();
        el.removeEventListener("click", handleClick);
        unlisteners.forEach((fn) => fn());
        invoke("close_pty", { id: ptyId }).catch(() => {});
        term.dispose();
        termRef.current = null;
        fitAddonRef.current = null;
        spawnedRef.current = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ptyId]); // Only re-run if ptyId changes (it shouldn't)

    // Re-fit when visibility changes (container size is 0 when hidden)
    useEffect(() => {
      if (visible && fitAddonRef.current) {
        const t = setTimeout(() => {
          fitAddonRef.current?.fit();
          termRef.current?.focus();
        }, 16);
        return () => clearTimeout(t);
      }
    }, [visible]);

    return (
      <div
        ref={containerRef}
        className="terminal-container"
        style={{ display: visible ? "flex" : "none", flex: 1 }}
      />
    );
  }
);
