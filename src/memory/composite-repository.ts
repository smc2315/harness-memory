/**
 * CompositeMemoryRepository — merges a global (cross-project) and a
 * project-level MemoryRepository into a single read interface.
 *
 * Read operations (list, getById) merge results from both tiers.
 * Write operations (create, update, promote, reject) target a specific tier.
 *
 * Each memory gets a `tier` tag ("global" | "project") so callers can
 * distinguish where a memory lives.
 */

import type { MemoryRepository, CreateMemoryInput, UpdateMemoryInput, ListMemoriesInput, MemoryRecord } from "./repository";

export type MemoryTier = "global" | "project";

export interface TieredMemoryRecord extends MemoryRecord {
  tier: MemoryTier;
}

export class CompositeMemoryRepository {
  private globalRepo: MemoryRepository | null;
  private projectRepo: MemoryRepository;

  constructor(projectRepo: MemoryRepository, globalRepo?: MemoryRepository) {
    this.projectRepo = projectRepo;
    this.globalRepo = globalRepo ?? null;
  }

  /** Whether a global tier is available. */
  get hasGlobal(): boolean {
    return this.globalRepo !== null;
  }

  /** Get the underlying repo for a specific tier. */
  getRepo(tier: MemoryTier): MemoryRepository {
    if (tier === "global") {
      if (this.globalRepo === null) {
        throw new Error("Global memory repository is not configured");
      }

      return this.globalRepo;
    }

    return this.projectRepo;
  }

  /** Get the project-level repo (for backward compatibility). */
  get project(): MemoryRepository {
    return this.projectRepo;
  }

  /** Get the global repo (may be null). */
  get global(): MemoryRepository | null {
    return this.globalRepo;
  }

  // -----------------------------------------------------------------------
  // Read operations — merge both tiers
  // -----------------------------------------------------------------------

  /** List memories from both tiers, tagged with their tier. */
  list(input: ListMemoriesInput): TieredMemoryRecord[] {
    const projectMemories = this.projectRepo.list(input).map(
      (m): TieredMemoryRecord => ({ ...m, tier: "project" }),
    );

    if (this.globalRepo === null) {
      return projectMemories;
    }

    const globalMemories = this.globalRepo.list(input).map(
      (m): TieredMemoryRecord => ({ ...m, tier: "global" }),
    );

    // Global memories come first (higher priority), then project.
    return [...globalMemories, ...projectMemories];
  }

  /** Find a memory by ID, checking both tiers. */
  getById(id: string): TieredMemoryRecord | null {
    const projectMemory = this.projectRepo.getById(id);

    if (projectMemory !== null) {
      return { ...projectMemory, tier: "project" };
    }

    if (this.globalRepo !== null) {
      const globalMemory = this.globalRepo.getById(id);

      if (globalMemory !== null) {
        return { ...globalMemory, tier: "global" };
      }
    }

    return null;
  }

  /** Find which tier a memory belongs to. */
  findTier(id: string): MemoryTier | null {
    if (this.projectRepo.getById(id) !== null) {
      return "project";
    }

    if (this.globalRepo !== null && this.globalRepo.getById(id) !== null) {
      return "global";
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Write operations — target a specific tier
  // -----------------------------------------------------------------------

  /** Create a memory in the specified tier (default: project). */
  create(input: CreateMemoryInput, tier: MemoryTier = "project"): MemoryRecord {
    return this.getRepo(tier).create(input);
  }

  /** Update a memory — automatically finds which tier it belongs to. */
  update(id: string, input: UpdateMemoryInput): MemoryRecord | null {
    const memoryTier = this.findTier(id);

    if (memoryTier === null) {
      return null;
    }

    return this.getRepo(memoryTier).update(id, input);
  }

  /** Update embedding — automatically finds which tier. */
  updateEmbedding(id: string, embedding: Float32Array): void {
    const memoryTier = this.findTier(id);

    if (memoryTier === null) {
      return;
    }

    this.getRepo(memoryTier).updateEmbedding(id, embedding);
  }
}
