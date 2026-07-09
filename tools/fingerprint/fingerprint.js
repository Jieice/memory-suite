#!/usr/bin/env node
"use strict";

const { chromium } = require("playwright");

const FONT_CANDIDATES = [
  "Arial",
  "Arial Black",
  "Arial Narrow",
  "Arial Rounded MT Bold",
  "Aptos",
  "Aptos Display",
  "Aptos Mono",
  "Aptos Narrow",
  "Aptos Serif",
  "Bahnschrift",
  "Baskerville",
  "Baskerville Old Face",
  "Batang",
  "Bodoni 72",
  "Bodoni MT",
  "Book Antiqua",
  "Bookman Old Style",
  "Bradley Hand ITC",
  "Calibri",
  "Calibri Light",
  "Calisto MT",
  "Cambria",
  "Cambria Math",
  "Candara",
  "Cascadia Code",
  "Cascadia Mono",
  "Century",
  "Century Gothic",
  "Century Schoolbook",
  "Chalkboard",
  "Chalkboard SE",
  "Chalkduster",
  "Charter",
  "Cochin",
  "Comic Sans MS",
  "Consolas",
  "Constantia",
  "Cooper Black",
  "Copperplate",
  "Copperplate Gothic Bold",
  "Copperplate Gothic Light",
  "Corbel",
  "Courier",
  "Courier New",
  "DejaVu Sans",
  "DejaVu Sans Mono",
  "DejaVu Serif",
  "Didot",
  "Dubai",
  "Ebrima",
  "FangSong",
  "Franklin Gothic Medium",
  "Futura",
  "Gabriola",
  "Garamond",
  "Georgia",
  "Gill Sans",
  "Gill Sans MT",
  "Helvetica",
  "Helvetica Neue",
  "Hoefler Text",
  "Impact",
  "Ink Free",
  "Javanese Text",
  "KaiTi",
  "Kefa",
  "Khmer UI",
  "Leelawadee UI",
  "Lucida Bright",
  "Lucida Calligraphy",
  "Lucida Console",
  "Lucida Fax",
  "Lucida Grande",
  "Lucida Handwriting",
  "Lucida Sans",
  "Lucida Sans Typewriter",
  "Malgun Gothic",
  "Marker Felt",
  "Menlo",
  "Microsoft Himalaya",
  "Microsoft JhengHei",
  "Microsoft JhengHei UI",
  "Microsoft New Tai Lue",
  "Microsoft PhagsPa",
  "Microsoft Sans Serif",
  "Microsoft Tai Le",
  "Microsoft YaHei",
  "Microsoft YaHei UI",
  "Microsoft Yi Baiti",
  "MingLiU",
  "MingLiU-ExtB",
  "Monaco",
  "Mongolian Baiti",
  "MS Gothic",
  "MS Mincho",
  "MS PGothic",
  "MS PMincho",
  "Myanmar Text",
  "Nirmala UI",
  "Noteworthy",
  "Optima",
  "Palatino",
  "Palatino Linotype",
  "Papyrus",
  "PingFang SC",
  "PingFang TC",
  "PMingLiU",
  "Rockwell",
  "Segoe Fluent Icons",
  "Segoe MDL2 Assets",
  "Segoe Print",
  "Segoe Script",
  "Segoe UI",
  "Segoe UI Emoji",
  "Segoe UI Historic",
  "Segoe UI Light",
  "Segoe UI Semibold",
  "Segoe UI Symbol",
  "SimHei",
  "SimSun",
  "Sitka",
  "Skia",
  "Snell Roundhand",
  "Songti SC",
  "Source Code Pro",
  "Tahoma",
  "Times",
  "Times New Roman",
  "Trebuchet MS",
  "Ubuntu",
  "Ubuntu Mono",
  "Verdana",
  "Yu Gothic",
  "Yu Gothic UI",
  "Yu Mincho",
  "Zapfino"
];

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-webgl", "--ignore-gpu-blocklist"]
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    await page.setContent("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>");

    const result = await page.evaluate(collectFingerprint, {
      fontCandidates: FONT_CANDIDATES
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

async function collectFingerprint({ fontCandidates }) {
  const collectedAt = new Date().toISOString();

  async function sha256Hex(value) {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
      throw new Error("crypto.subtle is unavailable in this browser context");
    }

    let bytes;
    if (typeof value === "string") {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
      bytes = new TextEncoder().encode(JSON.stringify(value));
    }

    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function safeCollect(name, collector) {
    try {
      return await collector();
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        collector: name
      };
    }
  }

  async function collectCanvas2D() {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 240;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D canvas context unavailable");
    }

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#123456");
    gradient.addColorStop(0.5, "#2bd4a7");
    gradient.addColorStop(1, "#f6d365");

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.globalAlpha = 0.82;
    ctx.fillStyle = "#ff3366";
    ctx.beginPath();
    ctx.arc(115, 88, 54, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.74;
    ctx.fillStyle = "#1f2937";
    ctx.beginPath();
    ctx.moveTo(260, 42);
    ctx.lineTo(424, 84);
    ctx.lineTo(364, 186);
    ctx.lineTo(222, 164);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 5;
    ctx.strokeRect(32, 34, 416, 172);

    ctx.font = "26px Arial";
    ctx.fillStyle = "#ffffff";
    ctx.fillText("Memory Suite fingerprint 0123456789", 42, 132);

    ctx.font = "20px Georgia";
    ctx.fillStyle = "rgba(0,0,0,0.82)";
    ctx.rotate(-0.05);
    ctx.fillText("canvas-2d probe: Δ≈中文かな", 58, 186);

    const dataURL = canvas.toDataURL("image/png");
    return {
      algorithm: "sha256",
      hash: await sha256Hex(dataURL),
      data_url_length: dataURL.length,
      size: { width: canvas.width, height: canvas.height }
    };
  }

  async function collectWebGL() {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;

    const gl = canvas.getContext("webgl", {
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true
    }) || canvas.getContext("experimental-webgl", {
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true
    });

    if (!gl) {
      throw new Error("WebGL context unavailable");
    }

    const vertexSource = `
      attribute vec3 a_position;
      attribute vec3 a_color;
      varying vec3 v_color;
      void main() {
        float perspective = 1.0 / (1.25 - a_position.z * 0.35);
        gl_Position = vec4(a_position.xy * perspective, a_position.z, 1.0);
        v_color = a_color;
      }
    `;
    const fragmentSource = `
      precision mediump float;
      varying vec3 v_color;
      void main() {
        gl_FragColor = vec4(v_color, 1.0);
      }
    `;

    function compileShader(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || "shader compile failed");
      }
      return shader;
    }

    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "program link failed");
    }

    const vertices = new Float32Array([
      -0.72, -0.68, -0.45, 1.00, 0.10, 0.28,
       0.72, -0.68, -0.45, 0.10, 0.82, 0.68,
       0.00,  0.74,  0.38, 0.98, 0.82, 0.22,

      -0.54,  0.48, -0.22, 0.20, 0.42, 0.92,
       0.60,  0.42, -0.10, 0.90, 0.18, 0.74,
       0.15, -0.38,  0.54, 0.18, 0.86, 0.96,

      -0.86,  0.12,  0.12, 0.84, 0.33, 0.19,
      -0.16, -0.82, -0.28, 0.38, 0.95, 0.28,
       0.88,  0.10,  0.22, 0.96, 0.96, 0.96
    ]);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
    const positionLocation = gl.getAttribLocation(program, "a_position");
    const colorLocation = gl.getAttribLocation(program, "a_color");

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.015, 0.02, 0.028, 1);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);

    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, stride, 0);

    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(colorLocation, 3, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);

    gl.drawArrays(gl.TRIANGLES, 0, 9);
    gl.finish();

    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const parameters = {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      shading_language_version: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      unmasked_vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
      unmasked_renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null
    };

    return {
      algorithm: "sha256",
      hash: await sha256Hex(pixels),
      size: { width: canvas.width, height: canvas.height },
      parameters
    };
  }

  async function collectAudio() {
    const AudioContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AudioContextClass) {
      throw new Error("OfflineAudioContext unavailable");
    }

    const sampleRate = 44100;
    const durationSeconds = 1;
    const context = new AudioContextClass(1, sampleRate * durationSeconds, sampleRate);

    const oscillator = context.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = 997;

    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -48;
    compressor.knee.value = 32;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    const gain = context.createGain();
    gain.gain.value = 0.37;

    oscillator.connect(compressor);
    compressor.connect(gain);
    gain.connect(context.destination);
    oscillator.start(0);
    oscillator.stop(durationSeconds);

    const rendered = await context.startRendering();
    const channel = rendered.getChannelData(0);
    const bytes = new Uint8Array(channel.buffer.slice(channel.byteOffset, channel.byteOffset + channel.byteLength));

    return {
      algorithm: "sha256",
      hash: await sha256Hex(bytes),
      sample_rate: rendered.sampleRate,
      length: rendered.length,
      duration_seconds: rendered.duration
    };
  }

  async function collectFonts() {
    const loaded = [];
    if (document.fonts && typeof document.fonts.forEach === "function") {
      document.fonts.forEach((fontFace) => {
        loaded.push({
          family: fontFace.family,
          style: fontFace.style,
          weight: fontFace.weight,
          stretch: fontFace.stretch,
          status: fontFace.status
        });
      });
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("2D canvas context unavailable for font detection");
    }

    const testText = "mmmmmmmmmmlliWWW@@@###中文かな한글0123456789";
    const baseFamilies = ["monospace", "serif", "sans-serif"];
    const fontSize = 72;

    const baseline = Object.fromEntries(baseFamilies.map((family) => {
      context.font = `${fontSize}px ${family}`;
      return [family, context.measureText(testText).width];
    }));

    const detected = [];
    for (const fontName of fontCandidates) {
      const present = baseFamilies.some((family) => {
        context.font = `${fontSize}px ${JSON.stringify(fontName)}, ${family}`;
        return context.measureText(testText).width !== baseline[family];
      });

      if (present) {
        detected.push(fontName);
      }
    }

    return {
      loaded,
      loaded_count: loaded.length,
      detected,
      detected_count: detected.length,
      tested_count: fontCandidates.length
    };
  }

  async function collectWebRTC() {
    if (!window.RTCPeerConnection) {
      throw new Error("RTCPeerConnection unavailable");
    }

    const startedAt = performance.now();
    const candidates = [];
    const addresses = new Set();
    const errors = [];

    const parseCandidate = (candidateText) => {
      const normalized = candidateText.startsWith("candidate:")
        ? candidateText
        : candidateText.replace(/^a=/, "");
      const parts = normalized.split(/\s+/);

      if (parts.length >= 8 && parts[0].startsWith("candidate:")) {
        const address = parts[4];
        const port = parts[5];
        const typeIndex = parts.indexOf("typ");
        const candidateType = typeIndex >= 0 ? parts[typeIndex + 1] : null;

        if (address) {
          addresses.add(address);
        }

        return {
          address,
          port,
          type: candidateType,
          protocol: parts[2],
          raw: candidateText
        };
      }

      const fallbackMatches = candidateText.match(/(?:\d{1,3}\.){3}\d{1,3}|[a-f0-9:]{3,}|[a-z0-9-]+\.local/gi) || [];
      for (const match of fallbackMatches) {
        addresses.add(match);
      }

      return { raw: candidateText };
    };

    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" }
      ]
    });

    try {
      peer.createDataChannel("fingerprint");

      const done = new Promise((resolve) => {
        const timeout = window.setTimeout(resolve, 3000);

        peer.onicecandidate = (event) => {
          if (!event.candidate) {
            window.clearTimeout(timeout);
            resolve();
            return;
          }

          candidates.push(parseCandidate(event.candidate.candidate));
        };

        peer.onicecandidateerror = (event) => {
          errors.push({
            address: event.address || null,
            port: event.port || null,
            url: event.url || null,
            error_code: event.errorCode || null,
            error_text: event.errorText || null
          });
        };
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await done;
    } finally {
      peer.close();
    }

    return {
      addresses: Array.from(addresses),
      candidates,
      errors,
      elapsed_ms: Math.round(performance.now() - startedAt)
    };
  }

  function collectScreen() {
    return {
      width: screen.width,
      height: screen.height,
      avail_width: screen.availWidth,
      avail_height: screen.availHeight,
      color_depth: screen.colorDepth,
      pixel_depth: screen.pixelDepth,
      device_pixel_ratio: window.devicePixelRatio
    };
  }

  function collectNavigator() {
    return {
      user_agent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: Array.from(navigator.languages || []),
      hardware_concurrency: navigator.hardwareConcurrency,
      device_memory: navigator.deviceMemory || null,
      max_touch_points: navigator.maxTouchPoints,
      webdriver: navigator.webdriver
    };
  }

  function collectTimezone() {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    return {
      time_zone: resolved.timeZone || null,
      locale: resolved.locale || null,
      offset_minutes: new Date().getTimezoneOffset()
    };
  }

  return {
    collected_at: collectedAt,
    runtime: {
      user_agent: navigator.userAgent,
      headless_hint: navigator.webdriver === true,
      secure_context: window.isSecureContext
    },
    canvas2d: await safeCollect("canvas2d", collectCanvas2D),
    webgl: await safeCollect("webgl", collectWebGL),
    audio: await safeCollect("audio", collectAudio),
    fonts: await safeCollect("fonts", collectFonts),
    webrtc: await safeCollect("webrtc", collectWebRTC),
    screen: collectScreen(),
    navigator: collectNavigator(),
    timezone: collectTimezone()
  };
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
