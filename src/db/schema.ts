import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * ColPali/ColQwen2 patch dimension. The coarse page vector is the patches
 * mean-pooled, so it shares this dimension. Defined locally (not imported from
 * config) so drizzle-kit can load this file without booting env validation.
 * Keep in sync with PATCH_DIM in config.ts.
 */
const EMBED_DIM = 128;

/** Raw bytes column — holds binary-quantized ColPali patch vectors. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/** The 3H pedagogical vector. Every node and objective carries exactly one. */
export const VECTORS = ["HEAD", "HEART", "HANDS"] as const;

// ---------------------------------------------------------------------------
// PROVENANCE + EVIDENCE
// ---------------------------------------------------------------------------

/** One ingested document (textbook, slide deck, guideline, transcript source). */
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stable human-facing id, e.g. "glaucoma-101". Used for direct page lookup. */
  sourceKey: text("source_key").notNull().unique(),
  title: text("title"),
  /** 'visual' (PDF/slides) | 'sequential' (transcript). Drives the ingest path. */
  kind: text("kind").notNull().default("visual"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One page image — the EVIDENCE layer. This is what ColPali embeds and what the
 * generator is shown. Knowledge nodes cite pages; the page carries the picture.
 *
 * Two ingestion paths share this table but not their vector space:
 *   - visual pages   -> coarseVector (HNSW) + patchVectors (bytea)  [ColPali]
 *   - transcript chunks -> textContent + startMs/endMs              [text path]
 */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),

    /** 'visual' | 'sequential'. */
    pageType: text("page_type").notNull().default("visual"),
    /** 1-based page/slide number (null for a transcript chunk). */
    pageNumber: integer("page_number"),

    // --- visual path (local storage; DB holds a key, not an S3 URL) ---------
    /** Key under PAGE_IMAGE_DIR for the rasterized page image. */
    imageKey: text("image_key"),
    /** Mean-pooled patch vector. Stage 1 (HNSW) searches this. */
    coarseVector: vector("coarse_vector", { dimensions: EMBED_DIM }),
    /** Binary-quantized patch vectors: patchCount * (dim/8) bytes. Stage 2. */
    patchVectors: bytea("patch_vectors"),
    patchCount: integer("patch_count"),

    // --- sequential path ----------------------------------------------------
    textContent: text("text_content"),
    startMs: real("start_ms"),
    endMs: real("end_ms"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** Stage 1: cosine over the pooled vector. Its recall caps the whole system. */
    index("pages_coarse_hnsw").using(
      "hnsw",
      t.coarseVector.op("vector_cosine_ops"),
    ),
    /** Direct reference: WHERE source_id = ? AND page_number = ?. */
    uniqueIndex("pages_source_page")
      .on(t.sourceId, t.pageNumber)
      .where(sql`${t.pageNumber} is not null`),
    index("pages_source").on(t.sourceId),
  ],
);

// ---------------------------------------------------------------------------
// KNOWLEDGE GRAPH (Mode 1 output — the citable, pedagogically structured layer)
// ---------------------------------------------------------------------------

/**
 * A Knowledge Node. `knKey` (e.g. "KN-014") is the citation identity the model
 * emits and we validate — code assigns it from a sequence; the model only
 * proposes content. That is R0.1 (source-locked grounding) made enforceable.
 */
export const knowledgeNodes = pgTable(
  "knowledge_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Auto-incrementing basis for the human-readable "KN-<n>" key. */
    seq: serial("seq").notNull(),
    /** Human-readable, stable citation key, e.g. "KN-014". Unique, assigned by code. */
    knKey: text("kn_key").notNull().unique(),

    /** The deck/textbook this belongs to. */
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** The page image that backs this node (its visual evidence). */
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "set null" }),

    /** 3H vector: HEAD | HEART | HANDS. */
    vector: text("vector").notNull(),
    /** Node type per Marzano typing: fact | mechanism | criterion | step | ... */
    nodeType: text("node_type"),
    title: text("title"),
    /** The node's factual content — what gets taught and cited. */
    content: text("content").notNull(),

    /** Faculty governance: 'draft' until reviewed; nothing teaches from 'draft'. */
    status: text("status").notNull().default("draft"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("kn_source").on(t.sourceId),
    index("kn_vector").on(t.vector),
    index("kn_status").on(t.status),
  ],
);

/**
 * A Learning Objective. `objKey` (e.g. "OBJ-07") is its stable identity.
 * Every objective carries a 3H vector, a taxonomy level, and an observable verb.
 */
export const objectives = pgTable(
  "objectives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: serial("seq").notNull(),
    objKey: text("obj_key").notNull().unique(),

    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),

    vector: text("vector").notNull(),
    /** e.g. "Bloom-Apply", "Dave-Precision", "SOLO-Relational". */
    taxonomyLevel: text("taxonomy_level"),
    /** The full observable statement, e.g. "Sets phaco parameters within safe ranges". */
    statement: text("statement").notNull(),

    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("obj_source").on(t.sourceId), index("obj_vector").on(t.vector)],
);

/** Predictable learner errors per node, each tagged with its distractor logic. */
export const misconceptions = pgTable(
  "misconceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => knowledgeNodes.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    /** Why a learner falls for it — the distractor logic it enables. */
    distractorLogic: text("distractor_logic"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("misconception_node").on(t.nodeId)],
);

/**
 * Assessment item seeds (2-3 stems per objective, used later by Mode 4).
 * `objectiveId` is NOT NULL — this is §3's "orphan items are forbidden",
 * enforced by the schema rather than hoped for in a prompt.
 */
export const assessmentSeeds = pgTable(
  "assessment_seeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: serial("seq").notNull(),
    aiKey: text("ai_key").notNull().unique(),

    objectiveId: uuid("objective_id")
      .notNull()
      .references(() => objectives.id, { onDelete: "cascade" }),

    /** MCQ | short-answer | script-concordance | key-feature | osce-checklist. */
    itemType: text("item_type"),
    stem: text("stem").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("seed_objective").on(t.objectiveId)],
);

// ---------------------------------------------------------------------------
// GRAPH EDGES (real FK join tables — arrays cannot enforce referential integrity)
// ---------------------------------------------------------------------------

/** Which nodes teach toward which objectives. */
export const nodeObjectives = pgTable(
  "node_objectives",
  {
    nodeId: uuid("node_id")
      .notNull()
      .references(() => knowledgeNodes.id, { onDelete: "cascade" }),
    objectiveId: uuid("objective_id")
      .notNull()
      .references(() => objectives.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("node_objective_pair").on(t.nodeId, t.objectiveId),
  ],
);

// ---------------------------------------------------------------------------
// LEARNER STATE (persistent per-learner profile — §4)
// ---------------------------------------------------------------------------

/** One learner. affect_signals stays JSONB; mastery/review are real tables. */
export const learners = pgTable("learners", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stable human-facing id, e.g. "ug-001". */
  extKey: text("ext_key").notNull().unique(),
  /** UG | PG | Fellow | CME. */
  level: text("level").notNull().default("UG"),
  /** { frustration, confidence, engagement } — soft signals, queried whole. */
  affect: jsonb("affect"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Mastery per (learner, objective), tracked on THREE separate vectors — never
 * averaged (§7 M4). Anchored 0-4 (SOLO / Miller×Dave / BARS). A real table, not
 * a JSONB blob, so "who is due to review OBJ-x" is a real query.
 */
export const mastery = pgTable(
  "mastery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    objectiveId: uuid("objective_id")
      .notNull()
      .references(() => objectives.id, { onDelete: "cascade" }),
    head: real("head").notNull().default(0),
    heart: real("heart").notNull().default(0),
    hands: real("hands").notNull().default(0),
    lastAssessed: timestamp("last_assessed", { withTimezone: true }),
  },
  (t) => [uniqueIndex("mastery_learner_objective").on(t.learnerId, t.objectiveId)],
);

/** Spaced-review schedule. Mode 3 seeds it; Mode 2 reads it. */
export const reviewQueue = pgTable(
  "review_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    objectiveId: uuid("objective_id")
      .notNull()
      .references(() => objectives.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    intervalDays: integer("interval_days").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("review_learner_objective").on(t.learnerId, t.objectiveId)],
);

// ---------------------------------------------------------------------------
// ASSESSMENT (Mode 4 — generated items, learner attempts, error log)
// ---------------------------------------------------------------------------

/**
 * A generated, gradeable item. objectiveId is NOT NULL — every item maps to an
 * objective (§3, orphans forbidden). Distractors are drawn from the misconception
 * bank at generation time.
 */
export const assessmentItems = pgTable(
  "assessment_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: serial("seq").notNull(),
    itemKey: text("item_key").notNull().unique(), // ITEM-<n>
    objectiveId: uuid("objective_id")
      .notNull()
      .references(() => objectives.id, { onDelete: "cascade" }),
    vector: text("vector").notNull(),
    taxonomyLevel: text("taxonomy_level"),
    itemType: text("item_type").notNull().default("MCQ"),
    stem: text("stem").notNull(),
    options: jsonb("options"), // string[]
    answerKey: text("answer_key"), // e.g. "A"
    rationale: jsonb("rationale"), // string[] parallel to options
    citedKnKeys: jsonb("cited_kn_keys"), // string[]
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("item_objective").on(t.objectiveId)],
);

/** One learner's graded attempt at an item. Scored on the item's own vector only. */
export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => assessmentItems.id, { onDelete: "cascade" }),
    response: text("response").notNull(),
    vector: text("vector").notNull(),
    /** Anchored rubric score 0-4 (§8). */
    score: real("score"),
    anchorLabel: text("anchor_label"),
    /** Quote from the learner's response supporting the score. */
    evidence: text("evidence"),
    /** high | medium | low — low routes to human review. */
    graderConfidence: text("grader_confidence"),
    facultyFlag: boolean("faculty_flag").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attempt_learner").on(t.learnerId)],
);

/** Diagnosed learner errors (§4). Mode 5 feeds on this; recurrence drives remediation. */
export const errorLog = pgTable(
  "error_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").references(() => assessmentItems.id, { onDelete: "set null" }),
    objectiveId: uuid("objective_id").references(() => objectives.id, { onDelete: "set null" }),
    /** knowledge | reasoning | technique | affect. */
    errorType: text("error_type").notNull(),
    description: text("description"),
    misconception: text("misconception"),
    recurrence: integer("recurrence").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("error_learner").on(t.learnerId)],
);

/**
 * Persistent chat history (§4 session_history) — the Teach conversation only
 * (what was asked, what was answered). Quiz/exam interactions aren't
 * duplicated here; they already have a durable home in
 * attempts/mastery/error_log. Written automatically as a side effect of every
 * `teach()` call, not via a separate endpoint — so the frontend can't forget
 * to log a turn.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    /** 'user' | 'bot'. */
    role: text("role").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_message_learner").on(t.learnerId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// SIMULATION (Mode 6 — turn-based case simulation)
// ---------------------------------------------------------------------------

/**
 * One case simulation run. `caseState` is the HIDDEN case (diagnosis, patient
 * persona/emotional arc, decision points tagged with real objective ids) —
 * never sent to the learner. Only the turn text in `simulationTurns` is.
 */
export const simulations = pgTable(
  "simulations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    /** The source deck/topic this case was generated from, if scoped to one. */
    sourceKey: text("source_key"),
    title: text("title").notNull(),
    /** Hidden: diagnosis, persona, emotional arc, decision points (§7 M6). */
    caseState: jsonb("case_state").notNull(),
    /** 'active' | 'ended'. */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("simulation_learner").on(t.learnerId)],
);

/**
 * One turn (learner action or agent/patient response) in a simulation.
 * `objectiveIds` tracks which OBJ-ids a learner turn touched — silently,
 * per §7 M6 ("track every learner action against OBJ-IDs silently") — used
 * by the end-of-sim debrief to know which objectives to score.
 */
export const simulationTurns = pgTable(
  "simulation_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    simulationId: uuid("simulation_id")
      .notNull()
      .references(() => simulations.id, { onDelete: "cascade" }),
    turnNumber: integer("turn_number").notNull(),
    /** 'learner' | 'agent'. */
    role: text("role").notNull(),
    text: text("text").notNull(),
    /** Objective ids this (learner) turn touched, if any. */
    objectiveIds: jsonb("objective_ids"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("simulation_turn_sim").on(t.simulationId, t.turnNumber)],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
export type KnowledgeNode = typeof knowledgeNodes.$inferSelect;
export type NewKnowledgeNode = typeof knowledgeNodes.$inferInsert;
export type Objective = typeof objectives.$inferSelect;
export type NewObjective = typeof objectives.$inferInsert;
export type Misconception = typeof misconceptions.$inferSelect;
export type AssessmentSeed = typeof assessmentSeeds.$inferSelect;
export type Learner = typeof learners.$inferSelect;
export type NewLearner = typeof learners.$inferInsert;
export type Mastery = typeof mastery.$inferSelect;
export type ReviewQueueEntry = typeof reviewQueue.$inferSelect;
export type AssessmentItem = typeof assessmentItems.$inferSelect;
export type NewAssessmentItem = typeof assessmentItems.$inferInsert;
export type Attempt = typeof attempts.$inferSelect;
export type ErrorLogEntry = typeof errorLog.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type Simulation = typeof simulations.$inferSelect;
export type NewSimulation = typeof simulations.$inferInsert;
export type SimulationTurn = typeof simulationTurns.$inferSelect;
export type NewSimulationTurn = typeof simulationTurns.$inferInsert;
