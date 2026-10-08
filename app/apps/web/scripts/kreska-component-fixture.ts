// Component evidence only: renders the production component, never a product route or mock face.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Kreska, type KreskaExpression } from '../src/ui/Kreska.js';

export const expressions: KreskaExpression[] = ['idle', 'working', 'thinking', 'writing', 'reading', 'waiting', 'asking', 'looking', 'loading', 'surprised', 'done', 'wink', 'celebrate', 'hello', 'asleep', 'worried'];
export const sizes = [16, 20, 24, 32, 48];
export function kreskaComponentFixture() {
  return expressions.map((expression) => `<section data-face="${expression}"><h2>${expression}</h2>${sizes.map((size) => `<div data-size="${size}">${renderToStaticMarkup(createElement(Kreska, { expression, size, label: `${expression} ${size}` }))}<span>${size}px</span></div>`).join('')}</section>`).join('');
}
