import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { migrateLegacyFinalReelPath } from "../../src/pipeline/output-names";
import { PipelineStage } from "../../src/pipeline/types";

const TMP = join(import.meta.dir, "__tmp_output_names__");

afterEach(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
});

describe("migrateLegacyFinalReelPath", () => {
  test("renames a legacy reel file and updates stored artifact paths", () => {
    mkdirSync(TMP, { recursive: true });
    const legacyPath = join(TMP, "421f5f78-d8a8-4306-baf5-e5974321a8d9_reel.mp4");
    writeFileSync(legacyPath, "video");

    let updated: Record<string, string> | null = null;
    const checkpoint = {
      updateClipArtifactPaths: (
        _runId: string,
        _clipId: string,
        artifactPaths: Record<string, string>,
      ) => {
        updated = artifactPaths;
      },
    };

    const result = migrateLegacyFinalReelPath({
      runId: "run-1",
      checkpoint: checkpoint as never,
      clip: {
        id: "421f5f78-d8a8-4306-baf5-e5974321a8d9",
        title: "The End of Permanent Allies and Enemies",
        hookLine: "",
        startTime: 0,
        endTime: 10,
        duration: 10,
        reasoning: "",
        viralScore: 1,
        tags: [],
      },
      progress: {
        clipId: "421f5f78-d8a8-4306-baf5-e5974321a8d9",
        clipIndex: 2,
        stage: PipelineStage.COMPOSE_REEL,
        status: "completed",
        artifactPaths: {
          finalReelPath: legacyPath,
        },
        updatedAt: new Date().toISOString(),
      },
    });

    expect(result).toEndWith("03-the-end-of-permanent-allies-and-enemies-421f5f78.mp4");
    expect(existsSync(result)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    expect(updated?.finalReelPath).toBe(result);
  });
});
