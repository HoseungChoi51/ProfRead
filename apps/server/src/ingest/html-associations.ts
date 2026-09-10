import { db, row } from '../db/index.js';

/** Run inside HTML publication's transaction, after anchors have been cloned.
 * HTML discussions follow the reattached source; PDF discussions keep their
 * immutable representation, including anchorless descendants of PDF threads.
 */
export function refreshHtmlPublicationAssociations(previousVersionId:string,nextVersionId:string):void{
  const next=row<{id:string;document_id:string}>("SELECT r.id,v.document_id FROM document_representations r JOIN document_versions v ON v.id=r.document_version_id WHERE r.document_version_id=? AND r.kind='html'",nextVersionId);
  const previous=row<{id:string;document_id:string}>("SELECT r.id,v.document_id FROM document_representations r JOIN document_versions v ON v.id=r.document_version_id WHERE r.document_version_id=? AND r.kind='html'",previousVersionId);
  if(!next||!previous||next.document_id!==previous.document_id)throw new Error('HTML publication source association is invalid');
  db.prepare(`UPDATE anchors SET representation_id=? WHERE document_version_id=? AND selector_json IS NULL
    AND (representation_id IS NULL OR representation_id IN (SELECT id FROM document_representations WHERE kind='html'))`).run(next.id,nextVersionId);
  db.prepare(`UPDATE threads SET representation_id=? WHERE document_id=?
    AND (representation_id IS NULL OR representation_id IN (SELECT id FROM document_representations WHERE kind='html'))
    AND (anchor_id IN (SELECT id FROM anchors WHERE document_version_id=? AND selector_json IS NULL AND representation_id=?)
      OR (anchor_id IS NULL AND representation_id=?)
      OR (anchor_id IS NULL AND parent_message_id IS NULL AND representation_id IS NULL))`).run(next.id,next.document_id,nextVersionId,next.id,previous.id);
  db.prepare(`WITH RECURSIVE following(id) AS (
    SELECT id FROM threads WHERE document_id=? AND representation_id=?
    UNION
    SELECT child.id FROM following parent JOIN messages message ON message.thread_id=parent.id
      JOIN threads child ON child.parent_message_id=message.id
      WHERE child.document_id=? AND child.anchor_id IS NULL AND (child.representation_id IS NULL OR child.representation_id=?)
    ) UPDATE threads SET representation_id=? WHERE id IN (SELECT id FROM following)`).run(next.document_id,next.id,next.document_id,previous.id,next.id);
  db.prepare('UPDATE document_view_preferences SET representation_id=? WHERE document_id=? AND representation_id=?').run(next.id,next.document_id,previous.id);
}
