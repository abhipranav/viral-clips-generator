import { afterEach, describe, expect, test } from "bun:test";

import { ClipIdentifier } from "../../src/modules/clip-identifier";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ClipIdentifier", () => {
  test("uses OpenAI Responses API with the gpt-5-mini model only", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        Authorization: "Bearer test-openai-key",
        "Content-Type": "application/json",
      });

      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gpt-5-mini");
      expect(body.text.format.type).toBe("json_schema");
      expect(body.text.format.strict).toBe(true);

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    clips: [
                      {
                        title: "A surprising empire collapse",
                        hookLine: "This empire fell in a week.",
                        startTime: 10,
                        endTime: 54,
                        reasoning: "Strong standalone reveal.",
                        viralScore: 91,
                        tags: ["history", "empire"],
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const identifier = new ClipIdentifier({
      openaiApiKey: "test-openai-key",
    } as never);

    const clips = await identifier.identify(
      {
        source: "whisper",
        language: "en",
        segments: [
          {
            text: "This empire collapsed in just one week after decades of buildup.",
            start: 10,
            end: 54,
            duration: 44,
          },
        ],
        fullText: "This empire collapsed in just one week after decades of buildup.",
        srtPath: "/tmp/test.srt",
      },
      {
        videoId: "video-123",
        title: "History Lecture",
        duration: 120,
        uploadDate: "2026-04-08",
        filePath: "/tmp/video.mp4",
        sourceType: "upload",
        sourceRef: "/tmp/video.mp4",
      },
    );

    expect(clips).toHaveLength(1);
    expect(clips[0]?.title).toBe("A surprising empire collapse");
    expect(clips[0]?.hookLine).toBe("This empire fell in a week.");
  });
});
