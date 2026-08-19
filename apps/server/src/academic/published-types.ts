import type { SafePublishedFetchOptions,SafePublishedResponse } from './published-fetch.js';

export type PublishedSourceWarning={code:string;message:string;sourceUrl?:string};
export type PublishedSourceAsset={sourcePath:string;sourceUrl:string;mimeType:string;bytes:Buffer;sourceRef?:string;sourceRefs?:string[]};
export interface PublishedSourceProvenance{
  requestedUrl:string;finalUrl:string;canonicalUrl:string;redirectChain:string[];
  doi:string|null;retrievedAt:string;adapter:string;license:string|null;contentSha256:string;
  directFailure?:string;pmcid?:string;
}
type SourceBase={title:string;provenance:PublishedSourceProvenance;warnings:PublishedSourceWarning[];assets:PublishedSourceAsset[]};
export type NormalizedPublishedHtml=SourceBase&{kind:'html';html:string};
export type NormalizedPublishedJats=SourceBase&{kind:'jats';bytes:Buffer;filename:string};
export type NormalizedPublishedPdf=SourceBase&{kind:'pdf';bytes:Buffer;filename:string};
export type NormalizedPublishedSource=NormalizedPublishedHtml|NormalizedPublishedJats|NormalizedPublishedPdf;
export type PublishedSourceFetcher=(url:string|URL,options?:SafePublishedFetchOptions)=>Promise<SafePublishedResponse>;
export type PublishedBundleConverter=(sourcePath:string,filename:string,signal?:AbortSignal)=>Promise<Buffer>;
export interface ResolvePublishedSourceOptions extends SafePublishedFetchOptions{
  fetcher?:PublishedSourceFetcher;now?:()=>string;maxAssets?:number;maxTotalBytes?:number;contactEmail?:string;
}
