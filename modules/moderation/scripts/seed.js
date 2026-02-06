const Scylla = require("../src/services/scylla.js");
const Moderation = require("../src/core/moderation.js");
const { fileURLToPath } = require('url');

const { dirname, join } = require('path');

const schemaPath = join(__dirname, '../src/core/db_schema.json');



// got this list from the users service(default seed data)
const allowedUserIds = [
  "range_test_user_id_3",
  "note-user-1",
  "mod-b",
  "lookup-b",
  "test-pending-query-user",
  "prio-user",
  "userZ",
  "type-user",
  "lookup-a",
  "userX",
  "Linden",
  "Alen"
];

const allTypes = [
  "text",
  "html",
  "image",
  "video",
  "audio",
  "gallery",
  "emoji",
  "icon",
  "tag",
  "tags",
  "personal_tag",
  "global_tag",
  "link",
  "report"
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const imagePool = [
  "https://images.unsplash.com/photo-1503023345310-bd7c1de61c7d?auto=format&fit=crop&w=1600&q=80",
  "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1600&q=80",
  "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1600&q=80"
];

const videoPool = [
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WeAreGoingOnBullrun.mp4",
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WhatCarCanYouGetForAGrand.mp4"
];

const audioPool = [
  "https://samplelib.com/lib/preview/mp3/sample-3s.mp3",
  "https://file-examples.com/storage/fe1bc454f7c3bd28d8a463fd/2017/11/file_example_MP3_700KB.mp3"
];

const linkPool = [
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
  "https://www.wikipedia.org/",
  "https://example.com/articles/performance"
];

function fileFormatFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const ext = path.split(".").pop();
    return ext ? ext.toLowerCase().split("?")[0] : null;
  } catch (_e) {
    return null;
  }
}

function buildContentPayload(type, idx) {
  switch (type) {
    case "text":
      return {
        contentType: "post",
        mediaType: null,
        content: {
          title: "Optional title",
          body: `Plain text body ${idx}`,
        },
      };
    case "html":
      return {
        contentType: "html",
        mediaType: null,
        content: {
          title: "Optional title",
          body: `<p>HTML content string for item ${idx}</p>`,
        },
      };
    case "image": {
      const url = pick(imagePool);
      const format = fileFormatFromUrl(url) || "jpeg";
      return {
        contentType: "media",
        mediaType: format,
        content: {
          url,
          thumbnail: `${url}&w=400&q=50`,
          width: 1600,
          height: 900,
          name: `Image ${idx}`,
          description: `Sample image ${idx}`,
          format,
        },
      };
    }
    case "video": {
      const url = pick(videoPool);
      const format = fileFormatFromUrl(url) || "mp4";
      return {
        contentType: "media",
        mediaType: format,
        content: {
          url,
          thumbnail: "https://peach.blender.org/wp-content/uploads/title_anouncement.jpg?x11217",
          duration: 60,
          width: 1280,
          height: 720,
          name: `Video ${idx}`,
          description: `Sample video ${idx}`,
          format,
        },
      };
    }
    case "audio": {
      const url = pick(audioPool);
      const format = fileFormatFromUrl(url) || "mp3";
      return {
        contentType: "media",
        mediaType: format,
        content: {
          url,
          thumbnail: null,
          duration: 30,
          name: `Audio ${idx}`,
          description: `Sample audio ${idx}`,
          format,
        },
      };
    }
    case "gallery":
      return {
        contentType: "media",
        mediaType: "gallery",
        content: {
          images: Array.from({ length: 3 }, (_v, j) => {
            const url = pick(imagePool);
            const format = fileFormatFromUrl(url) || "jpeg";
            return {
              url,
              thumbnail: `${url}&w=400&q=50`,
              width: 1600,
              height: 900,
              name: `Gallery image ${idx}-${j}`,
              description: `Gallery item ${idx}-${j}`,
              format,
              order: j,
            };
          }),
          name: `Gallery ${idx}`,
          description: `Gallery description ${idx}`,
        },
      };
    case "emoji":
      return {
        contentType: "emoji",
        mediaType: null,
        content: {
          emoji: "😄",
          unicode: "U+1F604",
          name: "smiling face with open mouth",
          description: null,
        },
      };
    case "icon":
      return {
        contentType: "icon",
        mediaType: "svg",
        content: {
          icon: "star",
          svg: "<svg viewBox='0 0 24 24'><path d='M12 2l3 7h7l-5.5 4.5L18 22l-6-3.5L6 22l1.5-8.5L2 9h7z'/></svg>",
          url: "https://cdn.example.com/icon.svg",
          name: null,
          description: null,
        },
      };
    case "tag":
    case "personal_tag":
    case "global_tag":
      return {
        contentType: "tag",
        mediaType: null,
        content: {
          tag: `tag-${idx}`,
          name: `Tag Name ${idx}`,
          description: `Description for tag ${idx}`,
        },
      };
    case "tags": {
      const tags = [
        { tag: "music", name: "Music", description: "Audio" },
        { tag: "art", name: "Art", description: "Visual" },
      ];
      return {
        contentType: "tag",
        mediaType: null,
        content: { tags },
      };
    }
    case "link":
      return {
        contentType: "link",
        mediaType: null,
        content: {
          url: pick(linkPool),
          title: "Article Title",
          thumbnail: null,
          name: null,
          description: null,
        },
      };
    case "report":
      return {
        contentType: "report",
        mediaType: null,
        content: {
          title: "Inappropriate Content",
          body: "Reported due to violation of guidelines.",
          reportType: pick(["spam", "abuse", "copyright"]),
          reportedBy: pick(allowedUserIds),
        },
      };
    default:
      return {
        contentType: "unknown",
        mediaType: null,
        content: { message: "fallback" },
      };
  }
}

async function generateAndCreateEntries(count = 100, { jitterMs = 0 } = {}) {
  console.log(`Starting creation of ${count} moderation entries...`);

  const promises = Array.from({ length: count }, async (_unused, i) => {
    const userId = pick(allowedUserIds);
    const type = pick(allTypes);
    const { contentType, mediaType, content } = buildContentPayload(type, i + 1);
    console.log("content:", content);
    const data = {
      userId,
      contentId: `${type}_content_${i + 1}`,
      type,
      contentType,
      mediaType,
      content,
      priority: Math.random() > 0.75 ? "high" : Math.random() > 0.9 ? "urgent" : "normal",
      isSystemGenerated: Math.random() > 0.5,
      isPreApproved: Math.random() > 0.2,
      // occasionally add notes
      ...(Math.random() > 0.4
        ? {
            notes: [
              {
                text: `Auto note for item ${i + 1}`,
                addedBy: userId,
                addedAt: Date.now(),
                isPublic: false,
              },
            ],
          }
        : {}),
    };

    const timestamp = jitterMs
      ? Date.now() + Math.floor((Math.random() - 0.5) * jitterMs)
      : undefined;

    try {
      const moderationId = await Moderation.createModerationEntry(data, timestamp);
      return { status: "success", moderationId };
    } catch (error) {
      return { status: "failed", error: error.message };
    }
  });

  const settled = await Promise.allSettled(promises);
  const results = settled.map((r) => r.value ?? { status: "failed", error: r.reason?.message });

  const successCount = results.filter((r) => r.status === "success").length;
  const errorCount = results.length - successCount;

  console.log(`\nSummary: ${successCount} succeeded, ${errorCount} failed`);
  console.log("Sample results (first 5):", results.slice(0, 5));

  return results;
}

async function seed() {
  await Scylla.loadTableConfigs(schemaPath);

  try {
    await Moderation.createModerationSchema();
    console.log("(INFO) Creating Moderation schemas successful");
  } catch (error) {
    if (error.message && error.message.includes('AlreadyExistsException')) {
      console.log("(INFO) Moderation table schema already exists, skipping creation.");
      return;
    }
    console.log("(ERROR) unable to create the table schema:", error);
    process.exit(1);
  }


  await generateAndCreateEntries(120, { jitterMs: 5000 });
}

(async () => {
  await seed();
})();
