/**
 * Assess a learner (Mode 4).
 *
 *   npm run assess -- ask --source angle-closure "acute angle closure"
 *   npm run assess -- grade --item ITEM-1 --learner ug-001 "B — the iris blocks the trabecular meshwork"
 *
 * --drafts assesses from unreviewed nodes (testing before faculty review).
 */
import { closeDb } from "../db/index.js";
import { assessAsk, assessGrade } from "./assess.js";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let drafts = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--drafts") drafts = true;
    else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      flags.set(arg.slice(2), value);
      i++;
    } else positional.push(arg);
  }
  return { action: positional[0], rest: positional.slice(1).join(" "), flags, drafts };
}

async function main(): Promise<void> {
  const { action, rest, flags, drafts } = parseArgs(process.argv.slice(2));

  if (action === "ask") {
    const item = await assessAsk(rest, {
      reviewedOnly: !drafts,
      ...(flags.get("source") ? { sourceKey: flags.get("source")! } : {}),
    });
    console.log(`\n${item.itemKey}  [${item.vector} · ${item.objKey} · ${item.taxonomyLevel ?? "n/a"}]`);
    console.log(item.stem);
    item.options.forEach((o, i) => console.log(`  ${String.fromCharCode(65 + i)}. ${o}`));
    console.log(`\nGrade with: npm run assess -- grade --item ${item.itemKey} --learner <id> "<answer>"`);
    return;
  }

  if (action === "grade") {
    const itemKey = flags.get("item");
    const learner = flags.get("learner");
    if (!itemKey || !learner || !rest) {
      console.error('usage: npm run assess -- grade --item <ITEM-n> --learner <id> "<answer>"');
      process.exit(1);
    }
    const r = await assessGrade(itemKey, learner, rest);
    console.log(`\n${itemKey} · ${r.objKey} · ${r.vector}`);
    console.log(`SCORE: ${r.score}/4 — ${r.anchorLabel}  (grader confidence: ${r.graderConfidence})`);
    console.log(`evidence: ${r.evidence}`);
    console.log(`error: ${r.errorType}${r.misconception ? ` — ${r.misconception}` : ""}`);
    if (r.facultyFlag) console.log(`🚩 FACULTY REVIEW (low grading confidence)`);
    console.log(`mastery(${r.objKey}) → HEAD ${r.mastery.head} · HEART ${r.mastery.heart} · HANDS ${r.mastery.hands}`);
    return;
  }

  console.error('usage: npm run assess -- ask "<topic>"  |  grade --item <ITEM-n> --learner <id> "<answer>"');
  process.exit(1);
}

main()
  .catch((error: unknown) => {
    console.error("\nassess failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
