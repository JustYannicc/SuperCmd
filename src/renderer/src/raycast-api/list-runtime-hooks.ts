/**
 * List runtime hooks.
 *
 * Extracted list registry/grouping helpers to keep List container module small.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { ItemRegistration, ListRegistryAPI } from './list-runtime-types';

function getReactTypeName(type: any): string {
  return String(type?.displayName || type?.name || type || '');
}

function buildValueSignature(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return `fn:${value.name || 'anonymous'}`;
  if (typeof value === 'symbol') return value.toString();

  if (Array.isArray(value)) {
    return `[${value.map((item) => buildValueSignature(item, seen)).join(',')}]`;
  }

  if (React.isValidElement(value)) {
    return `element:${getReactTypeName(value.type)}:${buildValueSignature((value as any).props, seen)}`;
  }

  if (typeof value === 'object') {
    if (value instanceof Date) return `date:${value.getTime()}`;
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== '_owner' && key !== '_store' && key !== 'ref' && key !== 'key')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${key}:${buildValueSignature(entryValue, seen)}`);

    return `{${entries.join(',')}}`;
  }

  return String(value);
}

function buildActionTypeSignature(actions: unknown): string {
  if (!React.isValidElement(actions)) return buildValueSignature(actions);
  return getReactTypeName((actions as React.ReactElement).type);
}

function buildListAccessorySignature(accessory: NonNullable<ItemRegistration['props']['accessories']>[number]): string {
  return [
    buildValueSignature(accessory?.text),
    buildValueSignature(accessory?.icon),
    buildValueSignature(accessory?.tag),
    buildValueSignature(accessory?.date),
    buildValueSignature(accessory?.tooltip),
  ].join('\u001e');
}

export function buildListItemVisibleSignature(item: ItemRegistration): string {
  const props = item.props;
  return [
    item.id,
    String(item.order),
    item.sectionTitle || '',
    buildValueSignature(props.id),
    buildValueSignature(props.title),
    buildValueSignature(props.subtitle),
    buildValueSignature(props.icon),
    props.accessories?.map(buildListAccessorySignature).join('\u001d') || '',
    props.keywords?.map((keyword) => JSON.stringify(keyword)).join('\u001d') || '',
    buildValueSignature(props.detail),
    buildValueSignature(props.quickLook),
    buildActionTypeSignature(props.actions),
  ].join('\u001f');
}

export function useListRegistry() {
  const registryRef = useRef(new Map<string, ItemRegistration>());
  const visibleSignatureRef = useRef(new Map<string, string>());
  const [registryVersion, setRegistryVersion] = useState(0);
  const pendingRef = useRef(false);

  const scheduleRegistryUpdate = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    queueMicrotask(() => {
      pendingRef.current = false;
      setRegistryVersion((value) => value + 1);
    });
  }, []);

  const registryAPI = useMemo<ListRegistryAPI>(() => ({
    set(id, data) {
      const existing = registryRef.current.get(id);
      if (existing) {
        // Hot path: an unrelated re-render (e.g. hover changing selection)
        // re-runs every <List.Item> render even though no content actually
        // changed. The renderOrder counter shifts uniformly so relative
        // order is preserved; just write it through and skip the costly
        // visible-signature work. Only publish when the id's visible
        // signature, section, or order actually changed.
        const propsChanged = existing.props !== data.props;
        const sectionChanged = existing.sectionTitle !== data.sectionTitle;
        const orderChanged = existing.order !== data.order;
        existing.props = data.props;
        existing.sectionTitle = data.sectionTitle;
        existing.order = data.order;
        if (!propsChanged && !sectionChanged && !orderChanged) return;

        const nextSignature = buildListItemVisibleSignature(existing);
        if (visibleSignatureRef.current.get(id) === nextSignature) return;
        visibleSignatureRef.current.set(id, nextSignature);
      } else {
        const item = { id, ...data };
        registryRef.current.set(id, item);
        visibleSignatureRef.current.set(id, buildListItemVisibleSignature(item));
      }
      scheduleRegistryUpdate();
    },
    delete(id) {
      if (!registryRef.current.has(id)) return;
      registryRef.current.delete(id);
      visibleSignatureRef.current.delete(id);
      scheduleRegistryUpdate();
    },
  }), [scheduleRegistryUpdate]);

  const allItems = useMemo(() => {
    const items = Array.from(registryRef.current.values());

    // Group by section, preserving the order each section first appeared,
    // then sort items within each section by their render order.
    // This prevents new items in a section from appearing after later sections.
    const sectionOrder = new Map<string | undefined, number>();
    for (const item of items) {
      if (!sectionOrder.has(item.sectionTitle)) {
        sectionOrder.set(item.sectionTitle, sectionOrder.size);
      }
    }

    return items.sort((a, b) => {
      const sectionA = sectionOrder.get(a.sectionTitle) ?? 0;
      const sectionB = sectionOrder.get(b.sectionTitle) ?? 0;
      if (sectionA !== sectionB) return sectionA - sectionB;
      return a.order - b.order;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryVersion]);

  return { registryAPI, allItems };
}

export function shouldUseEmojiGrid(filteredItems: ItemRegistration[], isShowingDetail: boolean, isEmojiOrSymbol: (value: string) => boolean): boolean {
  if (isShowingDetail || filteredItems.length < 24) return false;

  const iconToEmoji = (icon: any): string => {
    if (typeof icon === 'string') return icon;
    if (!icon || typeof icon !== 'object') return '';
    const source = icon.source ?? icon.light ?? icon.dark;
    if (typeof source === 'string') return source;
    if (source && typeof source === 'object') return typeof source.light === 'string' ? source.light : typeof source.dark === 'string' ? source.dark : '';
    return '';
  };

  let emojiIcons = 0;
  let iconsWithValue = 0;
  for (const item of filteredItems) {
    if ((item as any)?.props?.detail) return false;
    const emojiCandidate = iconToEmoji((item as any)?.props?.icon).trim();
    if (!emojiCandidate) continue;
    iconsWithValue += 1;
    if (isEmojiOrSymbol(emojiCandidate)) emojiIcons += 1;
  }

  if (iconsWithValue < Math.ceil(filteredItems.length * 0.95)) return false;
  return emojiIcons / Math.max(1, iconsWithValue) >= 0.95;
}

export function groupListItems(filteredItems: ItemRegistration[]) {
  const groups: { title?: string; items: { item: ItemRegistration; globalIdx: number }[] }[] = [];
  let currentSection: string | undefined | null = null;
  let globalIndex = 0;

  for (const item of filteredItems) {
    if (item.sectionTitle !== currentSection || groups.length === 0) {
      currentSection = item.sectionTitle;
      groups.push({ title: item.sectionTitle, items: [] });
    }
    groups[groups.length - 1].items.push({ item, globalIdx: globalIndex++ });
  }

  return groups;
}
