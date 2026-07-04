/**
 * Grid runtime shared items.
 *
 * Contains grid item registration contexts and row/cell renderers.
 */

import React, { createContext, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import { resolveTintColor } from './icon-runtime-assets';
import { renderIcon } from './icon-runtime-render';

type ResolveGridIconSource = (src: string) => string;

const GRID_CONTENT_FIT_CLASS_BY_FIT: Record<string, string> = {
  fill: 'w-full h-full object-cover',
  contain: 'w-full h-full object-contain',
};

const GRID_INSET_CLASS_BY_INSET: Record<string, string> = {
  zero: 'p-0',
  sm: 'p-1.5',
  md: 'p-3',
  lg: 'p-5',
};

function isImageLikeSourceString(value: string): boolean {
  const source = String(value || '').trim();
  if (!source) return false;
  if (
    source.startsWith('http') ||
    source.startsWith('data:') ||
    source.startsWith('sc-asset:') ||
    source.startsWith('file://') ||
    source.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(source) ||
    source.startsWith('\\\\')
  ) {
    return true;
  }
  return /\.(svg|png|jpe?g|gif|webp|ico|tiff?)(\?.*)?$/i.test(source);
}

function getGridColor(value: any): string | null {
  if (!value || typeof value !== 'object') return null;
  const hasVisualSource = value.source !== undefined || value.value !== undefined || value.fileIcon !== undefined;
  if (hasVisualSource) return null;
  return resolveTintColor(value.color) || null;
}

function normalizeGridSourceString(value: string, resolveIconSrc: ResolveGridIconSource): string {
  const source = String(value || '').trim();
  if (!source) return '';
  const resolved = resolveIconSrc(source);
  return resolved || source;
}

function toRenderableGridContent(value: any, resolveIconSrc: ResolveGridIconSource): any {
  if (!value) return null;
  if (typeof value === 'string') {
    const normalized = normalizeGridSourceString(value, resolveIconSrc);
    return normalized || null;
  }

  if (typeof value !== 'object') return null;

  if (typeof value.fileIcon === 'string' && value.fileIcon.trim()) {
    return { fileIcon: value.fileIcon.trim() };
  }

  if (value.source !== undefined) {
    const sourceValue = value.source;
    if (typeof sourceValue === 'string') {
      const normalizedSource = normalizeGridSourceString(sourceValue, resolveIconSrc);
      if (!normalizedSource) return null;
      const sourceTint =
        value.tintColor
        || (!isImageLikeSourceString(normalizedSource) ? value.color : undefined);
      return {
        source: normalizedSource,
        tintColor: sourceTint,
        mask: value.mask,
        fallback: value.fallback,
      };
    }
    if (sourceValue && typeof sourceValue === 'object') {
      return {
        source: sourceValue,
        tintColor: value.tintColor,
        mask: value.mask,
        fallback: value.fallback,
      };
    }
  }

  if (value.value !== undefined) {
    const nestedValue = value.value;
    if (typeof nestedValue === 'string') {
      const normalizedNested = normalizeGridSourceString(nestedValue, resolveIconSrc);
      if (!normalizedNested) return null;
      const nestedTint =
        !isImageLikeSourceString(normalizedNested) ? value.color : undefined;
      return nestedTint
        ? { source: normalizedNested, tintColor: nestedTint }
        : normalizedNested;
    }
    if (nestedValue && typeof nestedValue === 'object') {
      if (typeof nestedValue.fileIcon === 'string' && nestedValue.fileIcon.trim()) {
        return { fileIcon: nestedValue.fileIcon.trim() };
      }

      if (nestedValue.source !== undefined) {
        return nestedValue;
      }

      if (nestedValue.light !== undefined || nestedValue.dark !== undefined) {
        return { source: nestedValue };
      }
    }
  }

  return null;
}

function areGridItemRendererPropsEqual(previous: any, next: any): boolean {
  return (
    previous.title === next.title
    && previous.subtitle === next.subtitle
    && previous.content === next.content
    && previous.accessory === next.accessory
    && previous.isSelected === next.isSelected
    && previous.dataIdx === next.dataIdx
    && previous.itemHeight === next.itemHeight
    && previous.fit === next.fit
    && previous.inset === next.inset
  );
}

export interface GridSectionRegistration {
  id: string;
  title?: string;
  subtitle?: string;
  columns?: number;
  aspectRatio?: string;
  fit?: string;
  inset?: string;
}

export interface GridItemRegistration {
  id: string;
  props: {
    title?: string;
    subtitle?: string;
    content?: any;
    actions?: React.ReactElement;
    keywords?: string[];
    id?: string;
    accessory?: any;
    quickLook?: { name?: string; path: string };
  };
  section?: GridSectionRegistration;
  order: number;
}

export interface GridRegistryAPI {
  set: (id: string, data: Omit<GridItemRegistration, 'id'>) => void;
  delete: (id: string) => void;
}

export function createGridItemsRuntime(resolveIconSrc: (src: string) => string) {
  let gridItemOrderCounter = 0;
  let gridSectionOrderCounter = 0;

  const GridRegistryContext = createContext<GridRegistryAPI>({
    set: () => {},
    delete: () => {},
  });
  const GridSectionContext = createContext<GridSectionRegistration | undefined>(undefined);

  function GridItemComponent(props: any) {
    const registry = useContext(GridRegistryContext);
    const section = useContext(GridSectionContext);
    const stableId = useRef(props.id || `__gi_${++gridItemOrderCounter}`).current;
    const orderRef = useRef<number | null>(null);
    if (orderRef.current === null) orderRef.current = ++gridItemOrderCounter;

    useLayoutEffect(() => {
      registry.set(stableId, { props, section, order: orderRef.current! });
      return () => registry.delete(stableId);
    }, [props, registry, section, stableId]);

    return null;
  }

  function GridSectionComponent({ children, title, subtitle, columns, aspectRatio, fit, inset }: any) {
    const stableId = useRef(`__gs_${++gridSectionOrderCounter}`).current;
    const section = useMemo(
      () => ({ id: stableId, title, subtitle, columns, aspectRatio, fit, inset }),
      [aspectRatio, columns, fit, inset, stableId, subtitle, title],
    );

    return <GridSectionContext.Provider value={section}>{children}</GridSectionContext.Provider>;
  }

  const GridItemRenderer = React.memo(function GridItemRenderer({
    title,
    subtitle,
    content,
    accessory,
    isSelected,
    dataIdx,
    itemHeight,
    fit,
    inset,
    onSelect,
    onActivate,
    onContextAction,
  }: any) {
    const swatchColor = getGridColor(content);
    const renderableContent = swatchColor ? null : toRenderableGridContent(content, resolveIconSrc);
    const accessoryIcon = accessory?.icon ? toRenderableGridContent(accessory.icon, resolveIconSrc) : null;
    const accessoryTitle = typeof accessory?.tooltip === 'string' ? accessory.tooltip : undefined;
    const contentFitClass = GRID_CONTENT_FIT_CLASS_BY_FIT[fit] || GRID_CONTENT_FIT_CLASS_BY_FIT.contain;
    const insetClass = GRID_INSET_CLASS_BY_INSET[inset] || GRID_INSET_CLASS_BY_INSET.sm;

    return (
      <div
        data-idx={dataIdx}
        className={`relative rounded-lg border cursor-pointer transition-colors overflow-hidden flex flex-col ${
          isSelected
            ? 'border-[var(--text-secondary)] bg-[var(--launcher-card-selected-bg)] ring-2 ring-[var(--launcher-card-border)]'
            : 'border-[var(--launcher-card-border)] bg-[var(--launcher-card-bg)] hover:bg-[var(--launcher-card-hover-bg)]'
        }`}
        style={{
          height: `${itemHeight || 160}px`,
          boxShadow: isSelected
            ? '0 0 0 2px rgba(var(--on-surface-rgb), 0.24), inset 0 0 0 1px rgba(var(--on-surface-rgb), 0.16)'
            : undefined,
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          onActivate?.();
        }}
        onMouseMove={onSelect}
        onContextMenu={onContextAction}
      >
        <div className={`flex-1 flex items-center justify-center overflow-hidden min-h-0 ${insetClass}`}>
          {swatchColor ? (
            <div className="w-full h-full rounded" style={{ backgroundColor: swatchColor }} />
          ) : renderableContent ? (
            <div className="w-full h-full flex items-center justify-center">
              {renderIcon(renderableContent, contentFitClass)}
            </div>
          ) : (
            <div className="w-full h-full bg-[var(--surface-tint-2)] rounded flex items-center justify-center text-[var(--text-subtle)] text-2xl">
              {title ? title.charAt(0) : '?'}
            </div>
          )}
        </div>
        {(title || subtitle || accessoryIcon) && (
          <div className="px-2 pb-2 pt-1 flex-shrink-0">
            {accessoryIcon && (
              <div className="mb-1 flex justify-center text-[var(--text-subtle)]" title={accessoryTitle}>
                {renderIcon(accessoryIcon, 'w-3 h-3 object-contain')}
              </div>
            )}
            {title && <p className="truncate text-[11px] text-[var(--text-secondary)] text-center">{title}</p>}
            {subtitle && <p className="truncate text-[9px] text-[var(--text-subtle)] text-center">{subtitle}</p>}
          </div>
        )}
      </div>
    );
  }, areGridItemRendererPropsEqual);

  return {
    GridRegistryContext,
    GridItemComponent,
    GridSectionComponent,
    GridItemRenderer,
  };
}
