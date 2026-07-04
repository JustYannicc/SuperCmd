/**
 * List runtime detail panel helpers.
 *
 * Builds `List.Item.Detail` and handles markdown image source resolution.
 */

import React, { useMemo } from 'react';
import { renderSimpleMarkdown } from './detail-markdown';
import { useI18n } from '../i18n';

interface ListDetailDeps {
  getExtensionContext: () => { assetsPath: string };
  normalizeScAssetUrl: (url: string) => string;
  toScAssetUrl: (path: string) => string;
}

export function createListDetailRuntime(deps: ListDetailDeps) {
  const { getExtensionContext, normalizeScAssetUrl, toScAssetUrl } = deps;

  function resolveListDetailMarkdownImageSrc(src: string): string {
    const rawSrc = typeof src === 'string' ? src.trim() : '';
    if (!rawSrc) return '';
    const cleanSrc = rawSrc.replace(/\?.*$/, '');
    if (/^https?:\/\//.test(cleanSrc) || cleanSrc.startsWith('data:') || cleanSrc.startsWith('file://')) return cleanSrc;
    if (cleanSrc.startsWith('sc-asset://')) return normalizeScAssetUrl(cleanSrc);
    if (cleanSrc.startsWith('/')) return toScAssetUrl(cleanSrc);
    const context = getExtensionContext();
    if (context.assetsPath) return toScAssetUrl(`${context.assetsPath}/${cleanSrc}`);
    return cleanSrc;
  }

  const ListItemDetailComponent = ({ markdown, isLoading, metadata, children }: {
    markdown?: string;
    isLoading?: boolean;
    metadata?: React.ReactElement;
    children?: React.ReactNode;
  }) => {
    const { t } = useI18n();
    const extensionContext = getExtensionContext();
    const renderedMarkdown = useMemo(() => (
      markdown ? renderSimpleMarkdown(markdown, resolveListDetailMarkdownImageSrc) : null
    ), [extensionContext.assetsPath, markdown]);

    return (
      <div className="flex flex-col h-full overflow-y-auto px-3 py-2.5">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-white/50"><p className="text-sm">{t('common.loading')}</p></div>
        ) : (
          <>
            {markdown && <div className="text-white/80 text-sm leading-relaxed">{renderedMarkdown}</div>}
            {metadata}
            {children}
          </>
        )}
      </div>
    );
  };

  const ListItemDetail: any = Object.assign(ListItemDetailComponent, {});
  return { ListItemDetail };
}
