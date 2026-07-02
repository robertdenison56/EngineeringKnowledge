import { DEV_CALLER, getStore } from '../../lib/store';
import { captureKnowledge } from '../curation/actions';

export const dynamic = 'force-dynamic';

export default async function CapturePage() {
  const store = await getStore();
  const [projects, people] = await Promise.all([
    store.list(DEV_CALLER, { types: ['project'], limit: 500 }),
    store.list(DEV_CALLER, { types: ['person'], limit: 500 }),
  ]);

  return (
    <>
      <h2>Capture knowledge</h2>
      <p className="meta" style={{ marginBottom: '1rem' }}>
        Structured entry lands in the curation queue as <strong>unverified</strong> — a curator
        promotes it to the verified graph (PRD P0-9 guided capture). Linking a project or a known
        author connects the new knowledge into the graph immediately.
      </p>
      <form action={captureKnowledge} className="capture-form card">
        <label>
          Type
          <select name="type" defaultValue="lesson-learned">
            <option value="lesson-learned">Lesson learned</option>
            <option value="design-detail">Design detail</option>
            <option value="document">Document</option>
            <option value="material">Material / product</option>
            <option value="rfi">RFI</option>
          </select>
        </label>
        <label>
          Title *
          <input name="title" required placeholder="What happened / what is it?" />
        </label>
        <label>
          Summary
          <textarea
            name="summary"
            rows={4}
            placeholder="For lessons learned: what happened, root cause, and the fix — so it surfaces in future relevant queries."
          />
        </label>
        <label>
          Tags
          <input
            name="tags"
            placeholder="comma-separated, e.g. firestop, curtain-wall, fire-safety"
          />
        </label>
        <div className="form-row">
          <label>
            Project — links this knowledge <em>used-in</em> the project
            <select name="project" defaultValue="">
              <option value="">No project link</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Author — a name matching a known person creates an <em>authored-by</em> link
            <input name="author" list="ekg-people" placeholder="Who knows this best?" />
            <datalist id="ekg-people">
              {people.map((p) => (
                <option key={p.id} value={p.title} />
              ))}
            </datalist>
          </label>
        </div>
        <div className="form-row">
          <label>
            Source URL
            <input name="sourceUrl" type="url" placeholder="https://…" />
          </label>
          <label>
            Sheet (drawings)
            <input name="sheet" placeholder="e.g. A-501" />
          </label>
          <label>
            Page
            <input name="page" type="number" min={1} placeholder="e.g. 12" />
          </label>
        </div>
        <button type="submit">Submit to review queue</button>
      </form>
    </>
  );
}
