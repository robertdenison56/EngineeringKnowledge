import { captureKnowledge } from '../curation/actions';

export default function CapturePage() {
  return (
    <>
      <h2>Capture knowledge</h2>
      <p className="meta" style={{ marginBottom: '1rem' }}>
        Structured entry lands in the curation queue as <strong>unverified</strong> — a curator
        promotes it to the verified graph (PRD P0-9 guided capture).
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
            Author
            <input name="author" placeholder="Who knows this best?" />
          </label>
          <label>
            Source URL
            <input name="sourceUrl" type="url" placeholder="https://…" />
          </label>
        </div>
        <div className="form-row">
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
