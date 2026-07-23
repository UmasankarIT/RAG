/**
 * Ask the agent to teach a topic (Mode 3).
 *
 *   npm run teach -- --learner ug-001 "why does IOP rise in angle closure"
 *   npm run teach -- --learner ug-001 --source angle-closure --drafts "acute angle closure"
 *
 * --drafts teaches from unreviewed nodes (for testing before faculty review).
 */
import { closeDb } from "../db/index.js";
import { teach } from "./teach.js";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let drafts = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--drafts") {
      drafts = true;
    } else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      flags.set(arg.slice(2), value);
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { topic: positional.join(" "), flags, drafts };
}

async function main(): Promise<void> {
  const { topic, flags, drafts } = parseArgs(process.argv.slice(2));
  const learner = flags.get("learner");

  if (!learner || !topic) {
    console.error('usage: npm run teach -- --learner <id> [--source <sourceKey>] [--drafts] "<topic>"');
    process.exit(1);
  }

  const result = await teach(learner, topic, {
    reviewedOnly: !drafts,
    ...(flags.get("source") ? { sourceKey: flags.get("source")! } : {}),
  });

  console.log(`\n${"=".repeat(70)}`);
  if (!result.grounded && !result.smallTalk) {
    console.log("⚠ general knowledge — not grounded in your ingested sources\n");
  }
  console.log(result.text);
  console.log("=".repeat(70));
  if (result.grounded) {
    console.log(
      `\nretrieval: ${result.usedVisual ? "visual (ColPali)" : "lexical (text)"} · ` +
        `nodes: ${result.nodesUsed.map((n) => `${n.knKey}/${n.vector}`).join(", ")}`,
    );
  }
  console.log(`citations: ${result.citations.join(", ") || "(none)"}`);
  if (result.unknownCitations.length) {
    console.log(`⚠ ungrounded citations (not provided): ${result.unknownCitations.join(", ")}`);
  }
  console.log(`spaced review scheduled for: ${result.scheduledReview.join(", ") || "(none)"}`);
}

main()
  .catch((error: unknown) => {
    console.error("\nteach failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
