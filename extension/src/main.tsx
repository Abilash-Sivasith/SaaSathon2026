import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MagicCard } from "@/components/ui/magic-card";
import "./index.css";

const meters = [
  { id: "tab", label: "Tab" },
  { id: "mic", label: "Mic" },
  { id: "sys", label: "System" },
];

function Meter({ id, label }: { id: string; label: string }) {
  return (
    <div id={`meter-${id}`}>
      <MagicCard
        gradientOpacity={0}
        gradientFrom="#009EC8"
        gradientTo="#009EC8"
        className="relative overflow-hidden rounded-lg border border-sky-100 bg-white p-3 shadow-none"
      >
        <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.14em] text-[#545454]">
          <span>{label}</span>
          <span className="text-[#545454]/70">audio</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-sky-50">
          <div className="meter-bar" id={`bar-${id}`} />
        </div>
      </MagicCard>
    </div>
  );
}

function Popup() {
  useEffect(() => {
    if (document.querySelector('script[data-obli-popup-logic="true"]')) return;
    const script = document.createElement("script");
    script.src = "../popup.js";
    script.dataset.obliPopupLogic = "true";
    document.body.appendChild(script);
  }, []);

  return (
    <main className="app-shell relative flex min-h-[560px] flex-col gap-3 bg-[#f4f7f8] p-3 text-[#545454]">
      <MagicCard
        gradientOpacity={0}
        gradientFrom="#009EC8"
        gradientTo="#009EC8"
        className="relative overflow-hidden rounded-lg border border-sky-100 bg-white p-4 shadow-none"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#545454]">
              Oblique
            </div>
            <h1 className="mt-1 text-xl font-semibold leading-tight text-[#545454]">
              Sales Meeting Notes
            </h1>
          </div>
          <div className="rounded-md border border-sky-100 bg-sky-50 px-2 py-1 text-[11px] font-bold text-[#007a99]">
            Live
          </div>
        </div>
      </MagicCard>

      <MagicCard
        gradientOpacity={0}
        gradientFrom="#009EC8"
        gradientTo="#009EC8"
        className="relative overflow-hidden rounded-lg border border-sky-100 bg-white p-2 shadow-none"
      >
        <div id="preview-wrap" className="relative aspect-video overflow-hidden rounded-md bg-black">
          <video id="screen-preview" autoPlay muted playsInline />
          <div id="preview-placeholder">No screen capture active</div>
        </div>
      </MagicCard>

      <div className="grid grid-cols-3 gap-2">
        {meters.map((meter) => (
          <Meter key={meter.id} id={meter.id} label={meter.label} />
        ))}
      </div>

      <div className="control-grid">
        <button
          id="start"
          className="control-button control-button-start"
        >
          Start
        </button>
        <button
          id="stop"
          disabled
          className="control-button control-button-stop"
        >
          Stop
        </button>
      </div>

      <div className="control-grid">
        <button
          id="overlay-toggle"
          className="control-button control-button-overlay"
        >
          Show Overlay
        </button>
        <button
          id="popout"
          className="control-button control-button-panel"
        >
          Close Panel
        </button>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
