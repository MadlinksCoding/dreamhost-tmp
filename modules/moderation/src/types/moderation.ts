/**
 * ModerationType definitions
 *
 * Extracted from domain constants in `moderation/moderation.js` (`Moderation.TYPE`).
 * Keep this in sync with server-side values. The value `gallery` is an alias of
 * `image_gallery` and may be deprecated in future releases.
 */
import type { ModerationContent } from "./content.js";

export type ModerationType =
  | "image"
  | "video"
  | "text"
  | "html"
  | "link"
  | "report"
  | "tags"
  | "emoji"
  | "icon"
  | "tag"
  | "personal_tag"
  | "global_tag"
  | "image_gallery"
  | "gallery" // alias of image_gallery
  | "audio";

export const MODERATION_TYPE = {
  IMAGE: "image",
  VIDEO: "video",
  TEXT: "text",
  HTML: "html",
  LINK: "link",
  REPORT: "report",
  TAGS: "tags",
  EMOJI: "emoji",
  ICON: "icon",
  TAG: "tag",
  PERSONAL_TAG: "personal_tag",
  GLOBAL_TAG: "global_tag",
  IMAGE_GALLERY: "image_gallery",
  GALLERY: "gallery", // alias of image_gallery
  AUDIO: "audio",
} as const;

export type ModerationTypeValue =
  (typeof MODERATION_TYPE)[keyof typeof MODERATION_TYPE];

/**
 * Prefer `image_gallery` over `gallery` when emitting new records. Keep this union
 * aligned with server constants and seed usage.
 */

/**
 * Canonical enums aligned with `Moderation.STATUS`, `Moderation.PRIORITY`, `Moderation.ACTION`.
 */
export type ModerationStatus =
  | "pending"
  | "approved"
  | "approved_global"
  | "rejected"
  | "escalated";
export type ModerationPriority = "high" | "normal" | "urgent" | "low";
export type ModerationAction = "approve" | "reject" | "pending_resubmission";

/**
 * Note structure attached to moderation records.
 */
export interface ModerationNote {
  text: string;
  addedBy: string;
  addedAt: number; // epoch ms
  isPublic?: boolean;
}

/**
 * Meta history entry and meta block stored per record.
 */
export interface ModerationMetaHistoryEntry {
  action: string;
  timestamp: number; // epoch ms
  userId: string;
  previousStatus?: ModerationStatus;
  newStatus?: ModerationStatus;
  moderationType?: "standard" | "global";
  noteLength?: number;
}

export interface ModerationMeta {
  createdAt: number;
  createdBy: string;
  lastModifiedAt: number;
  lastModifiedBy: string;
  version: number;
  history: ModerationMetaHistoryEntry[];
  // optional operational flags used by meta updates
  contentDeleted?: boolean;
  contentDeletedAt?: number | null;
  updatedBy?: string;
}

/**
 * Optional DB key attributes (Dynamo/Alternator style).
 */
export interface ModerationDbKeys {
  pk?: string;
  sk?: string;
}

/**
 * Moderation record shape as returned by the API/domain.
 */
export interface ModerationRecord extends ModerationDbKeys {
  moderationId: string;
  userId: string;
  contentId: string;
  type: ModerationType;
  status: ModerationStatus;
  priority: ModerationPriority;
  contentType: string | null;
  mediaType: string | null;
  isSystemGenerated: boolean;
  isPreApproved: boolean;
  submittedAt: number;
  actionedAt: number | null;
  moderatedBy: string | null;
  escalatedBy: string | null;
  reason: string | null;
  action: ModerationAction | null;
  content?: ModerationContent | null; // see ModerationContent union below
  notes?: ModerationNote[];
  isDeleted: boolean;
  deletedAt: number | null;
  meta: ModerationMeta;
  // GSI helper attributes
  dayKey: string;
  statusSubmittedAt: string;
}

/**
 * Query options used by list endpoints.
 */
export interface ModerationQueryOptions {
  limit?: number;
  nextToken?: string | null;
  start?: number | null; // epoch ms
  end?: number | null; // epoch ms
  asc?: boolean;
}

/**
 * Generic paginated response.
 */
export interface PaginatedResult<T> {
  items: T[];
  nextToken?: string | null;
  hasMore?: boolean;
  count?: number;
  totalPages?: number;
}

/**
 * Aggregated counts per status.
 */
export interface ModerationCounts {
  pending: number;
  approved: number;
  approved_global: number;
  rejected: number;
  escalated: number;
}
