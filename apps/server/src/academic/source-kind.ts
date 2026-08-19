export const academicSourceKinds=['html','docx','tex','tex-zip','arxiv','pdf','url'] as const;
export type AcademicSourceKind=typeof academicSourceKinds[number];

export function isAcademicSourceKind(value:unknown):value is AcademicSourceKind{
  return typeof value==='string'&&(academicSourceKinds as readonly string[]).includes(value);
}
