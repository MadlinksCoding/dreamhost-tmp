type ModerationContentType =
  | "text"
  | "html"
  | "image"
  | "video"
  | "audio"
  | "gallery"
  | "emoji"
  | "icon"
  | "tag"
  | "tags"
  | "personal_tag"
  | "global_tag"
  | "link"
  | "report";

interface TextContent {
  body: string;
  title: string;
}

interface HtmlContent {
  body: string; // HTML string
  title: string;
}

interface ImageContent {
  url: string;
  thumbnail: string | null;
  width: number | null;
  height: number | null;
  // Optional accessibility and labeling
  name?: string | null;
  description?: string | null;
  // File format indicator (e.g., "jpeg", "png", "webp")
  format?: string | null;
}

interface VideoContent {
  url: string;
  thumbnail: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
// Optional accessibility and labeling
  name?: string | null;
  description?: string | null;
  // File format indicator (e.g., "mp4", "webm", "mov")
  format?: string | null;
}

interface AudioContent {
  url: string;
  thumbnail: string | null;
  duration: number | null;
  // Optional labeling for display contexts
  name?: string | null;
  description?: string | null;
  // File format indicator (e.g., "mp3", "aac", "wav")
  format?: string | null;
}

interface GalleryImage extends ImageContent {
  order?: number;
}

interface GalleryContent {
  images: GalleryImage[];
  // Optional labeling for the gallery as a whole
  name?: string | null;
  description?: string | null;
}

interface EmojiContent {
  emoji: string;
  unicode: string | null;
  // Optional human description (e.g., CLDR short name)
  name: string | null;
  description?: string | null;
}

interface IconContent {
  icon: string;
  svg: string | null;
  url: string | null;
  // Optional labeling
  name?: string | null;
  description?: string | null;
}

interface TagContent {
  tag: string;
  name: string;
  description: string;
}

// Represents a set of tags when type === 'tags'
interface TagsContent {
  tags: TagContent[];
}

interface LinkContent {
  url: string;
  title: string;
  thumbnail: string | null;
  // Optional human-friendly label
  name?: string | null;
  description: string | null;
}

interface ReportContent {
  title: string;
  body: string; 
  reportType: string;
  reportedBy: string;
}

interface FallbackContent {
  message: string;
  rawContentId: string;
}

interface ErrorContent {
  error: string;
  message: string;
}


export type ModerationContent =
	| TextContent
	| HtmlContent
	| ImageContent
	| VideoContent
	| AudioContent
	| GalleryContent
	| EmojiContent
	| IconContent
	| TagContent
	| TagsContent
	| LinkContent
	| ReportContent
	| FallbackContent
	| ErrorContent;
