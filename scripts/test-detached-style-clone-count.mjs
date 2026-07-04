#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { importTs } from './lib/ts-import.mjs';

const { cloneStylesIntoDocument } = await importTs(path.resolve('src/renderer/src/useDetachedPortalWindow.ts'));

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.textContent = '';
    this.rel = '';
    this.href = '';
    this.parent = null;
    this.appendCount = 0;
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    this.appendCount += 1;
    return child;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  querySelectorAll(selector) {
    if (selector === 'style, link[rel="stylesheet"]') {
      return this.children.filter((child) => (
        child.tagName.toLowerCase() === 'style' ||
        (child.tagName.toLowerCase() === 'link' && child.rel === 'stylesheet')
      ));
    }
    if (selector === '[data-sc-detached-style="1"]') {
      return this.children.filter((child) => child.getAttribute('data-sc-detached-style') === '1');
    }
    return [];
  }
}

class FakeDocument {
  constructor() {
    this.head = new FakeElement('head');
    this.body = new FakeElement('body');
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

function appendStyle(doc, text) {
  const style = doc.createElement('style');
  style.textContent = text;
  doc.head.appendChild(style);
  return style;
}

function appendLink(doc, href) {
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  doc.head.appendChild(link);
  return link;
}

test('detached portal style cloning skips unchanged lifecycle passes', (t) => {
  const source = new FakeDocument();
  const target = new FakeDocument();
  appendStyle(source, '.speak { color: red; }');
  appendLink(source, 'app://style.css');

  const first = cloneStylesIntoDocument(source, target);
  const firstAppendCount = target.head.appendCount;
  const second = cloneStylesIntoDocument(source, target);
  const secondAppendCount = target.head.appendCount;

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(firstAppendCount, 3);
  assert.equal(secondAppendCount, firstAppendCount);

  source.head.children[0].textContent = '.speak { color: blue; }';
  const third = cloneStylesIntoDocument(source, target);
  assert.equal(third, true);
  assert.equal(target.head.querySelectorAll('[data-sc-detached-style="1"]').length, 3);

  t.diagnostic(
    `[detached-style-clone-count] before unchangedPassAppends=${firstAppendCount * 2} ` +
    `after unchangedPassAppends=${secondAppendCount} changedPassAppends=${target.head.appendCount}`
  );
});
