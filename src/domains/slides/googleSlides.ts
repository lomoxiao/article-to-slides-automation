import { google } from "googleapis";
import type { slides_v1 } from "googleapis";
import { config } from "../../config.js";
import { getGoogleAuthClient } from "../../shared/googleAuth.js";
import type { GeneratedDeck, SlideOutline } from "../../types/content.js";

export async function createGoogleSlidesDeck(outline: SlideOutline): Promise<GeneratedDeck> {
  const auth = await getGoogleAuthClient();

  const slides = google.slides({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });

  const presentationId = config.GOOGLE_DRIVE_FOLDER_ID
    ? await createPresentationInDriveFolder(drive, outline.title)
    : await createPresentationInDefaultDrive(slides, outline.title);

  if (!presentationId) {
    throw new Error("Google Slides did not return a presentation ID");
  }

  const presentation = await slides.presentations.get({
    presentationId
  });

  const defaultSlideId = presentation.data.slides?.[0]?.objectId ?? undefined;
  const requests = buildDeckRequests(outline, defaultSlideId);

  if (requests.length > 0) {
    await slides.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests
      }
    });
  }

  return {
    presentationId,
    url: `https://docs.google.com/presentation/d/${presentationId}/edit`
  };
}

async function createPresentationInDriveFolder(
  drive: ReturnType<typeof google.drive>,
  title: string
): Promise<string | undefined | null> {
  const file = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: "application/vnd.google-apps.presentation",
      parents: config.GOOGLE_DRIVE_FOLDER_ID ? [config.GOOGLE_DRIVE_FOLDER_ID] : undefined
    },
    fields: "id",
    supportsAllDrives: true
  });

  return file.data.id;
}

async function createPresentationInDefaultDrive(
  slides: ReturnType<typeof google.slides>,
  title: string
): Promise<string | undefined | null> {
  const presentation = await slides.presentations.create({
    requestBody: {
      title
    }
  });

  return presentation.data.presentationId;
}

function buildDeckRequests(outline: SlideOutline, defaultSlideId?: string) {
  const requests: slides_v1.Schema$Request[] = [];

  if (defaultSlideId) {
    requests.push({
      deleteObject: {
        objectId: defaultSlideId
      }
    });
  }

  const titleSlideId = createObjectId("slide-title");
  const titleBoxId = createObjectId("title-box");
  const subtitleBoxId = createObjectId("subtitle-box");

  requests.push(
    createBlankSlideRequest(titleSlideId),
    ...createTextBoxRequests(titleSlideId, titleBoxId, outline.title, 60, 120, 600, 80, 30),
    ...createTextBoxRequests(titleSlideId, subtitleBoxId, outline.subtitle ?? "", 60, 220, 600, 60, 14)
  );

  outline.slides.forEach((slide, index) => {
    const slideId = createObjectId(`slide-${index}`);
    const headingId = createObjectId(`heading-${index}`);
    const bodyId = createObjectId(`body-${index}`);
    const bodyText = slide.bullets.map((bullet) => `- ${bullet}`).join("\n");

    requests.push(
      createBlankSlideRequest(slideId),
      ...createTextBoxRequests(slideId, headingId, slide.title, 48, 42, 624, 58, 24),
      ...createTextBoxRequests(slideId, bodyId, bodyText, 70, 130, 580, 260, 15)
    );
  });

  return requests;
}

function createBlankSlideRequest(objectId: string): slides_v1.Schema$Request {
  return {
    createSlide: {
      objectId,
      slideLayoutReference: {
        predefinedLayout: "BLANK"
      }
    }
  };
}

function createTextBoxRequests(
  pageObjectId: string,
  objectId: string,
  text: string,
  translateX: number,
  translateY: number,
  width: number,
  height: number,
  fontSize: number
): slides_v1.Schema$Request[] {
  return [
    {
      createShape: {
        objectId,
        shapeType: "TEXT_BOX",
        elementProperties: {
          pageObjectId,
          size: {
            width: { magnitude: width, unit: "PT" },
            height: { magnitude: height, unit: "PT" }
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX,
            translateY,
            unit: "PT"
          }
        }
      }
    },
    {
      insertText: {
        objectId,
        insertionIndex: 0,
        text
      }
    },
    {
      updateTextStyle: {
        objectId,
        style: {
          fontSize: {
            magnitude: fontSize,
            unit: "PT"
          },
          weightedFontFamily: {
            fontFamily: "Arial"
          }
        },
        textRange: {
          type: "ALL"
        },
        fields: "fontSize,weightedFontFamily"
      }
    }
  ];
}

function createObjectId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}
