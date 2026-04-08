import React from "react";
import { useCurrentFrame } from "remotion";
import type { CaptionGroup, CaptionOverlayProps } from "./types";

const FONT_SIZE = 52;
const ACTIVE_COLOR = "#FFD700";
const INACTIVE_COLOR = "#FFFFFF";

const TEXT_STROKE =
  "-3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000, 3px 3px 0 #000, " +
  "0 -3px 0 #000, 0 3px 0 #000, -3px 0 0 #000, 3px 0 0 #000";

const CaptionBox: React.FC<{ group: CaptionGroup; frame: number }> = ({ group, frame }) => {
  const words = group.words;
  const midpoint = Math.ceil(words.length / 2);
  const line1 = words.slice(0, midpoint);
  const line2 = words.slice(midpoint);

  const renderWord = (word: (typeof words)[0], idx: number) => {
    const isActive = frame >= word.startFrame && frame < word.endFrame;
    return (
      <span
        key={idx}
        style={{
          color: isActive ? ACTIVE_COLOR : INACTIVE_COLOR,
          marginRight: 12,
          textShadow: TEXT_STROKE,
        }}
      >
        {word.text.toUpperCase()}
      </span>
    );
  };

  return (
    <div
      style={{
        background: "rgba(0, 0, 0, 0.7)",
        padding: "14px 24px",
        borderRadius: 16,
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        maxWidth: "100%",
      }}
    >
      <div style={{ display: "flex", justifyContent: "center" }}>{line1.map(renderWord)}</div>
      {line2.length > 0 && (
        <div style={{ display: "flex", justifyContent: "center" }}>{line2.map(renderWord)}</div>
      )}
    </div>
  );
};

export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({ groups, width, height }) => {
  const frame = useCurrentFrame();

  const activeGroup = groups.find((g) => frame >= g.startFrame && frame < g.endFrame);
  const bottomPadding = Math.round(height * 0.14);

  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        fontFamily: "Arial, Helvetica, sans-serif",
        fontWeight: 800,
        fontSize: FONT_SIZE,
        position: "absolute",
        top: 0,
        left: 0,
        padding: `0 48px ${bottomPadding}px`,
        boxSizing: "border-box",
        backgroundColor: "transparent",
      }}
    >
      {activeGroup && <CaptionBox group={activeGroup} frame={frame} />}
    </div>
  );
};
