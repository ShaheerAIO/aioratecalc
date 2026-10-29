"use client";

import { useEffect, useRef } from "react";
import styles from "./FoodbuyOnboardStep.module.css";

type Props = {
  value: string;                   // the current signature as a PNG data URL, "" when blank
  onChange: (png: string) => void; // "" on Clear
  invalid?: boolean;
};

// Draw-to-sign with a mouse, pen or finger. Hands back a PNG cropped to the
// ink, transparent everywhere else, so it sits on the agreement's signature
// line rather than in a white box. No dependency: pointer events on a canvas.
export default function SignaturePad({ value, onChange, invalid }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const inked = useRef(false);

  // Size the backing store to the device's pixel ratio so strokes stay crisp.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111";
  }, []);

  // A cleared form (or one restored without a signature) clears the pad too.
  useEffect(() => {
    if (value || !inked.current) return;
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    inked.current = false;
  }, [value]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = e.currentTarget.getContext("2d")!;
    const { x, y } = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.01, y); // a tap leaves a dot
    ctx.stroke();
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d")!;
    const { x, y } = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    inked.current = true;
  };

  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    inked.current = true;
    onChange(croppedPng(canvasRef.current!));
  };

  const clear = () => {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    inked.current = false;
    onChange("");
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        className={`${styles.signaturePad} ${invalid ? styles.signaturePadInvalid : ""}`}
        aria-label="Signature pad: draw your signature"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div className={styles.signatureBar}>
        <span>Sign above with your mouse or finger</span>
        <button type="button" className={styles.linkBtnPlain} onClick={clear}>Clear</button>
      </div>
    </div>
  );
}

/** The canvas cropped to the ink's bounding box (plus a little air), as a PNG data URL. */
function croppedPng(canvas: HTMLCanvasElement): string {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const px = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return "";
  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}
