import { Command } from "commander";
import chalk from "chalk";

import { loadConfig } from "./config";
import { Downloader } from "./modules/downloader";
import { CheckpointManager } from "./pipeline/checkpoint";
import { deriveRunState } from "./pipeline/run-health";
import { PipelineOrchestrator } from "./pipeline/orchestrator";
import { PipelineStage, type ClipCandidate } from "./pipeline/types";
import { startApiServer } from "./server";
import { cleanRunArtifacts } from "./utils/fs";
import { createLogger } from "./utils/logger";

const log = createLogger("cli");

const program = new Command()
  .name("jiang-clips")
  .description("Reel Farmer - Automated short-form clip extraction pipeline")
  .version("1.0.0");

program
  .command("pipeline")
  .description("Run the full pipeline for a YouTube video")
  .argument("<url>", "YouTube video URL")
  .action(async (url: string) => {
    const config = loadConfig({ requireOpenAiApiKey: true });
    const checkpoint = new CheckpointManager(config.paths.checkpointDb);
    const orchestrator = new PipelineOrchestrator(config, checkpoint);

    try {
      const runId = await orchestrator.run(url);
      log.info(`Done! Run ID: ${runId}`);
      log.info(`Output: ./output/`);
    } catch (err) {
      log.error(`Pipeline failed: ${err}`);
      process.exit(1);
    } finally {
      checkpoint.close();
    }
  });

program
  .command("file")
  .description("Run the pipeline for a local video file")
  .argument("<file-path>", "Local video file path")
  .option("--title <title>", "Override the detected title")
  .action(async (filePath: string, opts: { title?: string }) => {
    const config = loadConfig({ requireOpenAiApiKey: true });
    const checkpoint = new CheckpointManager(config.paths.checkpointDb);
    const orchestrator = new PipelineOrchestrator(config, checkpoint);

    try {
      const runId = await orchestrator.runFile(filePath, opts.title);
      log.info(`Done! Run ID: ${runId}`);
      log.info(`Output: ./output/`);
    } catch (err) {
      log.error(`Pipeline failed: ${err}`);
      process.exit(1);
    } finally {
      checkpoint.close();
    }
  });

program
  .command("batch")
  .description("Process all videos from a YouTube channel")
  .argument("<channel-url>", "YouTube channel URL")
  .option("-l, --limit <n>", "Maximum videos to process", "10")
  .option("--skip-existing", "Skip already processed videos")
  .action(async (channelUrl: string, opts: { limit: string; skipExisting?: boolean }) => {
    const config = loadConfig({ requireOpenAiApiKey: true });
    const checkpoint = new CheckpointManager(config.paths.checkpointDb);
    const downloader = new Downloader();
    const orchestrator = new PipelineOrchestrator(config, checkpoint);

    try {
      const urls = await downloader.listChannelVideos(channelUrl, parseInt(opts.limit));
      log.info(`Found ${urls.length} videos`);

      const existingRuns = checkpoint.getAllRuns();
      const processedUrls = new Set(
        existingRuns.filter((r) => r.status === "completed").map((r) => r.videoUrl),
      );

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        if (opts.skipExisting && processedUrls.has(url)) {
          log.info(`[${i + 1}/${urls.length}] Skipping (already processed): ${url}`);
          continue;
        }

        log.info(`[${i + 1}/${urls.length}] Processing: ${url}`);
        try {
          await orchestrator.run(url);
        } catch (err) {
          log.error(`Failed: ${err}`);
          log.info("Continuing with next video...");
        }
      }
    } finally {
      checkpoint.close();
    }
  });

program
  .command("api")
  .description("Start the Bun API for uploads, queueing, and dashboard integration")
  .action(async () => {
    const config = loadConfig({ requireOpenAiApiKey: true });
    startApiServer(config);
  });

program
  .command("resume")
  .description("Resume a previously interrupted pipeline run")
  .argument("<run-id>", "Pipeline run ID")
  .action(async (runId: string) => {
    const config = loadConfig({ requireOpenAiApiKey: true });
    const checkpoint = new CheckpointManager(config.paths.checkpointDb);
    const orchestrator = new PipelineOrchestrator(config, checkpoint);

    try {
      await orchestrator.resume(runId);
      log.info("Resume completed");
    } catch (err) {
      log.error(`Resume failed: ${err}`);
      process.exit(1);
    } finally {
      checkpoint.close();
    }
  });

program
  .command("status")
  .description("Show status of pipeline runs")
  .argument("[run-id]", "Optional specific run ID")
  .action(async (runId?: string) => {
    const config = loadConfig({ requireOpenAiApiKey: false });
    const checkpoint = new CheckpointManager(config.paths.checkpointDb);

    if (runId) {
      const run = checkpoint.getRunInfo(runId);
      if (!run) {
        log.error(`Run not found: ${runId}`);
        process.exit(1);
      }
      const stageResults = checkpoint.getStageResultsForRun(runId);
      const clipProgress = checkpoint.getClipProgressEntries(runId);
      const clipStageResult = checkpoint.getStageResult<ClipCandidate[]>(
        runId,
        PipelineStage.IDENTIFY_CLIPS,
      );
      const clipCandidates = Array.isArray(clipStageResult?.data) ? clipStageResult.data : [];
      const derived = deriveRunState({
        run,
        stageResults,
        clipProgress,
        clipCandidates,
      });
      console.log(chalk.bold(`\nRun: ${run.id}`));
      console.log(`  Video: ${run.videoUrl}`);
      console.log(`  Status: ${colorStatus(derived.status)}`);
      console.log(`  Stage: ${derived.currentStage}`);
      console.log(`  Created: ${run.createdAt}`);
      console.log(`  Updated: ${run.updatedAt}`);
      if (derived.status !== run.status) {
        console.log(`  Stored status: ${run.status}`);
      }
    } else {
      const runs = checkpoint.getAllRuns();
      if (runs.length === 0) {
        console.log("No pipeline runs found.");
        return;
      }
      console.log(chalk.bold(`\n${runs.length} pipeline runs:\n`));
      for (const run of runs) {
        const stageResults = checkpoint.getStageResultsForRun(run.id);
        const clipProgress = checkpoint.getClipProgressEntries(run.id);
        const clipStageResult = checkpoint.getStageResult<ClipCandidate[]>(
          run.id,
          PipelineStage.IDENTIFY_CLIPS,
        );
        const clipCandidates = Array.isArray(clipStageResult?.data) ? clipStageResult.data : [];
        const derived = deriveRunState({
          run,
          stageResults,
          clipProgress,
          clipCandidates,
        });
        console.log(
          `  ${chalk.dim(run.id.slice(0, 8))} ${colorStatus(derived.status)} ${chalk.cyan(derived.currentStage)} ${run.videoTitle || run.videoId}`,
        );
      }
    }

    checkpoint.close();
  });

program
  .command("clean")
  .description("Clean intermediate artifacts for a run")
  .argument("<run-id>", "Pipeline run ID")
  .option("--all", "Remove all artifacts including final output")
  .action(async (runId: string, opts: { all?: boolean }) => {
    const config = loadConfig({ requireOpenAiApiKey: false });
    cleanRunArtifacts(config.paths.data, runId, !opts.all);
    log.info(`Cleaned artifacts for run: ${runId}`);
  });

function colorStatus(status: string): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "failed":
      return chalk.red(status);
    case "running":
      return chalk.yellow(status);
    case "queued":
      return chalk.blue(status);
    case "incomplete":
      return chalk.magenta(status);
    default:
      return chalk.gray(status);
  }
}

program.parse();
