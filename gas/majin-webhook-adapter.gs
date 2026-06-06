/**
 * Thin webhook adapter for the majin slide renderer.
 *
 * Add this file to the same Google Apps Script project as the original
 * `コード.gs`. It assumes `generateSlidesFromWebApp` already exists.
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');

    if (payload.action === 'convertJsonToSvgBatch') {
      const jsonStrings = payload.jsonStrings || [];

      if (!Array.isArray(jsonStrings)) {
        throw new Error('payload.jsonStrings must be an array.');
      }

      return jsonResponse({
        ok: true,
        results: convertJsonToSvgBatch(jsonStrings)
      });
    }

    const slideData = payload.slideData;
    const settings = Object.assign(getDefaultWebhookSettings(), payload.settings || {});
    const presentationId = payload.presentationId || null;
    const imageUpdateOption = payload.imageUpdateOption || 'update';

    if (!Array.isArray(slideData)) {
      throw new Error('payload.slideData must be an array.');
    }

    const url = generateSlidesFromWebApp(
      JSON.stringify(slideData),
      settings,
      presentationId,
      imageUpdateOption
    );

    const generatedPresentationId = extractPresentationIdFromUrl(url);
    const linkSummary = tryLinkSourceUrlsInPresentation_(generatedPresentationId);

    return jsonResponse({
      ok: true,
      url: url,
      presentationId: generatedPresentationId,
      linkSummary: linkSummary
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  }
}

function getDefaultWebhookSettings() {
  return {
    primaryColor: '#4285F4',
    largeFontColor: '#333333',
    smallFontColor: '#1F2937',
    backgroundColor: '#FFFFFF',
    gradientStart: '#4285F4',
    gradientEnd: '#ff52df',
    fontFamily: 'Noto Sans JP',
    showTitleUnderline: true,
    showBottomBar: true,
    showDateColumn: true,
    showPageNumber: true,
    enableGradient: false,
    footerText: '© Your Company',
    headerLogoUrl: '',
    closingLogoUrl: '',
    titleBgUrl: '',
    closingBgUrl: '',
    sectionBgUrl: '',
    mainBgUrl: '',
    driveFolderId: ''
  };
}

function jsonResponse(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function extractPresentationIdFromUrl(url) {
  const text = String(url || '');
  const presentationMatch = text.match(/\/presentation\/d\/([^/]+)/);
  if (presentationMatch) return presentationMatch[1];

  const openMatch = text.match(/[?&]id=([^&]+)/);
  return openMatch ? openMatch[1] : null;
}

const SOURCE_SLIDE_PATTERN_ = /(\u53c2\u7167\u30bd\u30fc\u30b9|\u51fa\u5178|\u53c2\u7167\u5143|Sources?)/i;
const URL_HEADER_PATTERN_ = /^URL$/i;
const URL_PATTERN_ = /https?:\/\/[^\s<>"']+/g;

function tryLinkSourceUrlsInPresentation_(presentationId) {
  try {
    return linkSourceUrlsInPresentation_(presentationId);
  } catch (error) {
    return {
      linkedCount: 0,
      skippedCount: 1,
      error: String(error && error.message ? error.message : error)
    };
  }
}

function linkSourceUrlsInPresentation_(presentationId) {
  const summary = {
    linkedCount: 0,
    skippedCount: 0
  };

  if (!presentationId) {
    summary.skippedCount += 1;
    return summary;
  }

  const presentation = SlidesApp.openById(presentationId);
  const slides = presentation.getSlides();

  slides.forEach(function(slide) {
    if (!isSourceSlide_(slide)) {
      return;
    }

    const tableResult = linkSourceUrlTables_(slide);
    summary.linkedCount += tableResult.linkedCount;
    summary.skippedCount += tableResult.skippedCount;

    if (!tableResult.foundUrlColumn) {
      const fallbackResult = linkUrlsInSlideText_(slide);
      summary.linkedCount += fallbackResult.linkedCount;
      summary.skippedCount += fallbackResult.skippedCount;
    }
  });

  return summary;
}

function isSourceSlide_(slide) {
  const textParts = [];

  slide.getShapes().forEach(function(shape) {
    const text = getShapeText_(shape);
    if (text) {
      textParts.push(text);
    }
  });

  return SOURCE_SLIDE_PATTERN_.test(textParts.join('\n'));
}

function getShapeText_(shape) {
  try {
    return shape.getText().asString();
  } catch (error) {
    return '';
  }
}

function linkSourceUrlTables_(slide) {
  const result = {
    linkedCount: 0,
    skippedCount: 0,
    foundUrlColumn: false
  };

  slide.getTables().forEach(function(table) {
    const urlColumns = findUrlColumns_(table);

    if (urlColumns.length === 0) {
      return;
    }

    result.foundUrlColumn = true;

    for (let rowIndex = 1; rowIndex < table.getNumRows(); rowIndex += 1) {
      urlColumns.forEach(function(columnIndex) {
        const cellResult = linkUrlsInTableCell_(table, rowIndex, columnIndex);
        result.linkedCount += cellResult.linkedCount;
        result.skippedCount += cellResult.skippedCount;
      });
    }
  });

  return result;
}

function findUrlColumns_(table) {
  const columns = [];

  if (table.getNumRows() === 0) {
    return columns;
  }

  for (let columnIndex = 0; columnIndex < table.getNumColumns(); columnIndex += 1) {
    const headerText = getTableCellText_(table, 0, columnIndex).trim();
    if (URL_HEADER_PATTERN_.test(headerText)) {
      columns.push(columnIndex);
    }
  }

  return columns;
}

function getTableCellText_(table, rowIndex, columnIndex) {
  try {
    return table.getCell(rowIndex, columnIndex).getText().asString();
  } catch (error) {
    return '';
  }
}

function linkUrlsInSlideText_(slide) {
  const result = {
    linkedCount: 0,
    skippedCount: 0
  };

  slide.getShapes().forEach(function(shape) {
    try {
      const textResult = linkUrlsInTextRange_(shape.getText());
      result.linkedCount += textResult.linkedCount;
      result.skippedCount += textResult.skippedCount;
    } catch (error) {
      result.skippedCount += 1;
    }
  });

  slide.getTables().forEach(function(table) {
    for (let rowIndex = 0; rowIndex < table.getNumRows(); rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < table.getNumColumns(); columnIndex += 1) {
        const cellResult = linkUrlsInTableCell_(table, rowIndex, columnIndex);
        result.linkedCount += cellResult.linkedCount;
        result.skippedCount += cellResult.skippedCount;
      }
    }
  });

  return result;
}

function linkUrlsInTableCell_(table, rowIndex, columnIndex) {
  try {
    return linkUrlsInTextRange_(table.getCell(rowIndex, columnIndex).getText());
  } catch (error) {
    return {
      linkedCount: 0,
      skippedCount: 1
    };
  }
}

function linkUrlsInTextRange_(textRange) {
  const result = {
    linkedCount: 0,
    skippedCount: 0
  };
  const text = textRange.asString();
  let match;

  URL_PATTERN_.lastIndex = 0;
  while ((match = URL_PATTERN_.exec(text)) !== null) {
    const rawUrl = match[0];
    const url = trimTrailingUrlPunctuation_(rawUrl);
    const start = match.index;
    const end = start + url.length;

    if (!url) {
      result.skippedCount += 1;
      continue;
    }

    try {
      textRange.getRange(start, end).getTextStyle().setLinkUrl(url);
      result.linkedCount += 1;
    } catch (error) {
      result.skippedCount += 1;
    }
  }

  return result;
}

function trimTrailingUrlPunctuation_(url) {
  return String(url || '').replace(/[\)\u3001\u3002\uff0c\uff0e,.;:!?\uff01\uff1f\]\}]+$/g, '');
}
