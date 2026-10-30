import type { Material } from '@flux/contracts';
import { Button, Icon, Input, Option, Select } from '../ui';
import { day } from '../app/messageParts';
import { RefLink } from '../place/origin';
import type { ProjectMaterials } from './useProjectMaterials';

interface Props {
  materials: ProjectMaterials; projectName: string; writable: boolean; inThread: boolean;
  /** The composer the tray belongs to; the form's fields are named after it. */
  composerId: string;
  author: (id: string) => string;
  onCite: (material: Material) => void;
}

/** The sources tray above a composer (#36): the project's saved materials, and the form that adds one. */
export function MaterialTray({ materials, projectName, writable, inThread, composerId, author, onCite }: Props) {
  const { items, total, form } = materials;
  return <section id={`${inThread ? 'thread' : 'project'}-sources`} aria-label="Project materials" className="project-convo__materials">
    <div className="project-convo__section-head"><h3>Sources · saved for {projectName}</h3><span>{total}</span><button type="button" className="project-convo__tray-close" aria-label="Close sources" onClick={() => { materials.setSourcesOpen(false); form.setOpen(false); }}><Icon name="x" size={14} /></button></div>
    <div className="project-convo__tray">
      {items.map((material) => <article className="project-convo__material" key={material.materialId}><div><strong>{writable ? material.title : <RefLink className="project-convo__material-read" to={`/materials/${material.materialId}/versions/${material.version}`}>{material.title}</RefLink>}</strong><small>v{material.version} · {author(material.authorId)} · {day(material.updatedAt)}{material.url ? <> · <a href={material.url} target="_blank" rel="noreferrer">Open link</a></> : null}</small></div>{writable ? <Button variant="link" onClick={() => onCite(material)}>Discuss this version</Button> : null}</article>)}
      {!items.length ? <p className="project-convo__muted">{writable ? "Text and links you save here can be cited in any reply." : "No sources have been saved to this project yet."}</p> : null}
      {materials.more ? <Button variant="quiet" busy={materials.moreBusy} onClick={() => void materials.loadMore()}>Load more materials</Button> : null}
      {writable && !form.open ? <Button variant="secondary" icon="plus" disabled={form.busy} onClick={() => form.setOpen(true)}>Add material</Button> : null}
      {writable && form.open ? <MaterialForm form={form} composerId={composerId} /> : null}
      {form.error && !form.open ? <p role="alert">{form.error}</p> : null}
    </div>
  </section>;
}

function MaterialForm({ form, composerId }: { form: ProjectMaterials['form']; composerId: string }) {
  return <form className="project-convo__material-form" onSubmit={(event) => void form.submit(event)}><fieldset className="project-convo__material-fields" disabled={form.busy}>
    {form.privateDrafts.length ? <label>Start from a private draft<Select value={form.sourceDraft?.id ?? ''} onChange={form.chooseDraft}><Option value="">No private draft</Option>{form.privateDrafts.map((item) => <Option key={item.id} value={item.id}>{item.title} · v{item.version}</Option>)}</Select></label> : null}
    <Input label="Title" value={form.title} onChange={(event) => form.setTitle(event.target.value)} required maxLength={200} />
    <label htmlFor={`${composerId}-material-body`}>Text</label><textarea id={`${composerId}-material-body`} value={form.body} onChange={(event) => form.setBody(event.target.value)} maxLength={100000} />
    <Input label="Link (optional)" type="url" value={form.url} onChange={(event) => form.setUrl(event.target.value)} />
    {form.sourceDraft ? <p className="project-convo__publication">Publishing selected content from private draft v{form.sourceDraft.version}. Review the exact text and link above. Your original draft remains private.</p> : null}
    {form.error ? <p role="alert">{form.error}</p> : null}
    <div className="project-convo__form-actions"><Button type="submit" variant="primary" busy={form.busy}>Save for this project</Button><Button variant="quiet" disabled={form.busy} onClick={() => form.setOpen(false)}>Cancel</Button></div>
  </fieldset></form>;
}
