#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# != 1 ]]; then
  echo "usage: $0 BUILT_PROFREAD_IMAGE" >&2
  exit 2
fi
readonly PROFREAD_IMAGE="$1"
readonly SOURCE_VOLUME="afterdraft-data"
readonly TARGET_VOLUME="profread-data"
docker image inspect "${PROFREAD_IMAGE}" >/dev/null
docker volume inspect "${SOURCE_VOLUME}" >/dev/null
if [[ -n "$(docker ps --filter "volume=${SOURCE_VOLUME}" --format '{{.ID}}')" ]]; then
  echo "Stop every container using afterdraft-data before cloning the library." >&2
  exit 1
fi
if docker volume inspect "${TARGET_VOLUME}" >/dev/null 2>&1; then
  echo "profread-data already exists; refusing to overwrite a library or a previous migration attempt." >&2
  exit 1
fi
docker run --rm --network none --user root \
  --volume "${SOURCE_VOLUME}:/source:ro" --entrypoint node "${PROFREAD_IMAGE}" --input-type=module -e '
    import {lstatSync} from "node:fs";
    import {DatabaseSync} from "node:sqlite";
    if(!lstatSync("/source/afterdraft.sqlite").isFile()) throw new Error("Legacy database must be a regular file");
    const db=new DatabaseSync("/source/afterdraft.sqlite",{readOnly:true});
    try {
      for(const name of ["migrations","documents","document_versions","messages"])
        if(!db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?").get("table",name)) throw new Error("Legacy application schema is missing");
      if(db.prepare("PRAGMA integrity_check").get().integrity_check!=="ok"||db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Legacy database failed integrity checks");
      console.log(JSON.stringify({legacyDatabaseVerified:true,documents:db.prepare("SELECT COUNT(*) count FROM documents").get().count}));
    } finally {db.close()}
  '
docker volume create "${TARGET_VOLUME}" >/dev/null
docker run --rm --network none \
  --volume "${SOURCE_VOLUME}:/source:ro" --volume "${TARGET_VOLUME}:/target" \
  alpine:3.22 cp -a /source/. /target/
docker run --rm --network none --user root \
  --volume "${SOURCE_VOLUME}:/source:ro" --volume "${TARGET_VOLUME}:/target:ro" \
  --entrypoint node "${PROFREAD_IMAGE}" --input-type=module -e '
    import {readdirSync,readFileSync,readlinkSync} from "node:fs";
    import {join} from "node:path";
    import {createHash} from "node:crypto";
    const digest=path=>createHash("sha256").update(readFileSync(path)).digest("hex");
    let count=0;
    function verify(relative="") {
      for(const entry of readdirSync(join("/source",relative),{withFileTypes:true})) {
        const next=join(relative,entry.name),source=join("/source",next),target=join("/target",next);
        if(entry.isDirectory()) verify(next);
        else if(entry.isSymbolicLink()) { if(readlinkSync(source)!==readlinkSync(target)) throw new Error("Source link mismatch"); }
        else if(entry.isFile()) { if(digest(source)!==digest(target)) throw new Error("Source file checksum mismatch"); count++; }
        else throw new Error("Unexpected source filesystem entry");
      }
    }
    verify(); console.log(JSON.stringify({copiedFilesVerified:count}));
  '
docker run --rm --network none --volume "${TARGET_VOLUME}:/data" \
  --entrypoint node "${PROFREAD_IMAGE}" --input-type=module -e '
    import {openProfReadDatabase} from "/app/apps/server/dist/db/open.js";
    const db=openProfReadDatabase("/data");
    try {
      if(db.prepare("PRAGMA integrity_check").get().integrity_check!=="ok") throw new Error("Database integrity check failed");
      if(db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Database foreign key check failed");
      console.log(JSON.stringify({database:"profread.sqlite",verified:true}));
    } finally {db.close()}
  '
echo "ProfRead volume prepared. The original afterdraft-data volume remains unchanged."
