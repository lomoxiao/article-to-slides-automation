/**
 * Thin webhook adapter for the majin slide renderer.
 *
 * Add this file to the same Google Apps Script project as the original
 * `コード.gs`. It assumes `generateSlidesFromWebApp` already exists.
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
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

    return jsonResponse({
      ok: true,
      url: url,
      presentationId: extractPresentationIdFromUrl(url)
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
