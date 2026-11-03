import { readFileSync } from 'node:fs';
import { installImageGallery } from './gallery.js';
import { createImageReferenceBridge } from './composer-reference.js';

const css = readFileSync(new URL('./gallery.css', import.meta.url), 'utf8');

/** Inline script is generated from static code and JSON, never model output. */
export function galleryScript(nativeOptions = {}) {
  const options = JSON.stringify({ css, ...nativeOptions }).replaceAll('<', '\\u003c');
  return '(' + installImageGallery.toString() + ')(' + options + ', ' + createImageReferenceBridge.toString() + ');';
}
