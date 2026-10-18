import { renderSVG } from 'uqr';

/*
 * The enrollment QR code.
 *
 * Rendered on the server so the browser receives a picture instead of a QR
 * encoder, and as SVG so it stays sharp at any size and inherits the dialog's
 * colours. Nothing secret leaves the response that was not already in it: the
 * SVG encodes the same otpauth URI shown as text below it.
 */
export function renderQr(text: string): string {
  return renderSVG(text, {
    border: 2,
    // Fixed colours rather than currentColor: a scanner needs the contrast,
    // and the dialog puts this on a light plate in both themes.
    blackColor: '#05070b',
    whiteColor: '#ffffff',
  });
}
