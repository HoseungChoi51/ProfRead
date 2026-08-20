import {useEffect,useState} from 'react';
import {api} from './api.js';
import {ImportReviewPage} from './AcademicImport.js';
import {Library} from './Library.js';
import {Reader} from './Reader.js';

export type AppRoute={kind:'library'}|{kind:'document';id:string}|{kind:'import';id:string};
export function parseAppRoute(pathname:string):AppRoute{const document=pathname.match(/^\/documents\/([^/]+)\/?$/);if(document)return{kind:'document',id:decodeURIComponent(document[1]!)};const job=pathname.match(/^\/imports\/([^/]+)\/?$/);if(job)return{kind:'import',id:decodeURIComponent(job[1]!)};return{kind:'library'}}
function routePath(route:AppRoute):string{return route.kind==='library'?'/':route.kind==='document'?`/documents/${encodeURIComponent(route.id)}`:`/imports/${encodeURIComponent(route.id)}`}

export function App(){
  const[authenticated,setAuthenticated]=useState<boolean|null>(null),[route,setRoute]=useState<AppRoute>(()=>parseAppRoute(location.pathname));
  useEffect(()=>{api('/api/auth/session').then(()=>setAuthenticated(true)).catch(()=>setAuthenticated(false))},[]);
  const open=(next:AppRoute)=>{history.pushState({},'',routePath(next));setRoute(next)};
  useEffect(()=>{const listener=()=>setRoute(parseAppRoute(location.pathname));addEventListener('popstate',listener);return()=>removeEventListener('popstate',listener)},[]);
  if(authenticated===null)return <main className="center"><p>Opening your library…</p></main>;
  if(!authenticated)return <Login onSuccess={()=>setAuthenticated(true)}/>;
  if(route.kind==='document')return <Reader documentId={route.id} onBack={()=>open({kind:'library'})}/>;
  if(route.kind==='import')return <ImportReviewPage jobId={route.id} onBack={()=>open({kind:'library'})} onOpenDocument={id=>open({kind:'document',id})}/>;
  return <Library onOpen={id=>open({kind:'document',id})} onReviewImport={id=>open({kind:'import',id})} onLogout={()=>api('/api/auth/logout',{method:'POST'}).then(()=>setAuthenticated(false))}/>;
}

function Login({onSuccess}:{onSuccess:()=>void}){const[password,setPassword]=useState(''),[error,setError]=useState('');return <main className="login"><form onSubmit={async event=>{event.preventDefault();setError('');try{await api('/api/auth/login',{method:'POST',body:JSON.stringify({password})});onSuccess()}catch(reason){setError((reason as Error).message)}}}><img className="profread-logo login-logo" src="/profread_logo.svg" width="1400" height="380" alt="ProfRead — Ask. Critique. Understand."/><h1 className="sr-only">ProfRead</h1><p>Your private reading room.</p><label>Password<input autoFocus type="password" value={password} onChange={event=>setPassword(event.target.value)} autoComplete="current-password"/></label>{error&&<p role="alert" className="error">{error}</p>}<button>Enter library</button></form></main>}
