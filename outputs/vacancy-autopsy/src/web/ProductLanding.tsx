import "./product-landing.css";

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h16m-6-6 6 6-6 6"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function Brand() {
  return (
    <a
      className="pl-brand"
      href="#product-main"
      aria-label="Vacancy Autopsy home"
    >
      <span className="pl-brand-mark" aria-hidden="true">
        v<span>∴</span>
      </span>
      <span>
        vacancy<span>autopsy</span>
      </span>
    </a>
  );
}

/** Public product story. Private cases are loaded only after opening the workspace. */
export function ProductLanding({ onStart }: { onStart: () => void }) {
  return (
    <div className="product-landing">
      <a className="pl-skip" href="#product-main">
        Skip to product
      </a>
      <header className="pl-header pl-container">
        <Brand />
        <nav aria-label="Product navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#technology">Technology</a>
        </nav>
        <button className="pl-header-action" type="button" onClick={onStart}>
          Open workspace <Arrow diagonal />
        </button>
      </header>
      <main id="product-main">
        <section
          className="pl-hero pl-container"
          aria-labelledby="product-title"
        >
          <div className="pl-hero-copy">
            <p className="pl-eyebrow">
              <span /> YOUR JOB SEARCH, WITH FEWER DEAD ENDS
            </p>
            <h1 id="product-title">
              Before you apply,
              <br />
              know where
              <br />
              the job <em>stands.</em>
            </h1>
            <p className="pl-hero-description">
              A listing can linger after the opening disappears. Check the
              original employer source before you spend another evening
              applying.
            </p>
            <div className="pl-hero-actions">
              <button
                className="pl-button pl-button-dark"
                type="button"
                onClick={onStart}
              >
                Check a job <Arrow />
              </button>
              <a className="pl-quiet-link" href="#how-it-works">
                How it works <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="pl-hero-assurance">
              Private checks. No applications sent. No employer contacted.
            </p>
          </div>
          <aside
            className="pl-question"
            aria-label="The question behind a better application"
          >
            <div className="pl-question-top">
              <span>
                BEFORE THE RÉSUMÉ.
                <br />
                BEFORE THE COVER LETTER.
              </span>
              <span aria-hidden="true">↗</span>
            </div>
            <p className="pl-question-line">
              Is this exact opening
              <br />
              still listed by
              <br />
              <em>the employer?</em>
            </p>
            <div className="pl-source-connection" aria-hidden="true">
              <span>THE ADVERTISEMENT</span>
              <div>
                <span />
                <b>↗</b>
                <span />
              </div>
              <span>THE ORIGINAL SOURCE</span>
            </div>
            <p className="pl-question-bottom">
              A better starting point
              <br />
              for your next move.
            </p>
          </aside>
        </section>
        <section
          className="pl-source-strip pl-container"
          aria-label="Core product technologies"
        >
          <span>EXTRACTION · PRIORITIZATION · DELIVERY</span>
          <div>
            <span>Tinker</span>
            <span>TabPFN</span>
            <span>Render</span>
          </div>
        </section>
        <section
          className="pl-story pl-container"
          aria-labelledby="product-problem"
        >
          <p className="pl-eyebrow">
            YOUR TIME BELONGS TO YOUR NEXT OPPORTUNITY.
          </p>
          <div>
            <h2 id="product-problem">
              The internet remembers jobs that employers have already removed.
            </h2>
            <p>
              That stale link still asks for your attention. Your résumé. Your
              time. Vacancy Autopsy helps you find out what the original source
              says, so you can choose your next step with a clearer picture.
            </p>
          </div>
        </section>
        <section
          className="pl-how pl-container"
          id="how-it-works"
          aria-labelledby="how-title"
        >
          <div className="pl-section-heading">
            <div>
              <p className="pl-eyebrow">FROM LINK TO NEXT STEP</p>
              <h2 id="how-title">
                Less second-guessing.
                <br />
                <em>A clearer next move.</em>
              </h2>
            </div>
            <p>
              Start with the posting you found. We follow its exact identity
              back to the public employer source.
            </p>
          </div>
          <div className="pl-steps">
            <article>
              <span className="pl-step-number">01</span>
              <h3>Bring the opening.</h3>
              <p>
                Paste a Greenhouse, Lever or Ashby posting link. The exact job
                ID keeps similar titles from becoming the same job.
              </p>
            </article>
            <article>
              <span className="pl-step-number">02</span>
              <h3>Check the original.</h3>
              <p>
                Find out whether the posting is still present at the employer’s
                public source. Access problems and incomplete responses stay
                uncertain.
              </p>
            </article>
            <article>
              <span className="pl-step-number">03</span>
              <h3>Choose your next step.</h3>
              <p>
                Read the finding, open the current source and decide where to
                put your effort. Save the check and return when you need a fresh
                answer.
              </p>
            </article>
          </div>
        </section>
        <section
          className="pl-outcomes pl-container"
          aria-labelledby="outcomes-title"
        >
          <div className="pl-outcome-intro">
            <p className="pl-eyebrow">A FINDING YOU CAN USE</p>
            <h2 id="outcomes-title">
              Clarity includes
              <br />
              <em>knowing the limits.</em>
            </h2>
            <p>
              A missing job does not establish an employer’s intent. A present
              one does not guarantee a hire.
            </p>
          </div>
          <div className="pl-outcome-list">
            <article>
              <span
                className="pl-outcome-icon pl-outcome-open"
                aria-hidden="true"
              >
                ↗
              </span>
              <div>
                <h3>Verified open</h3>
                <p>
                  The exact posting is present at the checked source. Review the
                  employer’s current application route.
                </p>
              </div>
            </article>
            <article>
              <span
                className="pl-outcome-icon pl-outcome-absent"
                aria-hidden="true"
              >
                —
              </span>
              <div>
                <h3>Not currently listed</h3>
                <p>
                  The ID is absent from a complete public board response. Look
                  for a reposted opening before relying on the ad.
                </p>
              </div>
            </article>
            <article>
              <span className="pl-outcome-icon" aria-hidden="true">
                ?
              </span>
              <div>
                <h3>Inconclusive</h3>
                <p>
                  The available source cannot support a finding. Recheck later
                  or obtain a direct employer posting link.
                </p>
              </div>
            </article>
          </div>
        </section>
        <section
          className="pl-technology"
          id="technology"
          aria-labelledby="technology-title"
        >
          <div className="pl-container">
            <div className="pl-section-heading">
              <div>
                <p className="pl-eyebrow">BUILT AROUND YOUR NEXT MOVE</p>
                <h2 id="technology-title">
                  Understand the listing.
                  <br />
                  Prioritize the check.
                  <br />
                  <em>Reach the answer.</em>
                </h2>
              </div>
              <div className="pl-tech-context">
                <p>
                  Read the listing with Tinker. Order your checks with TabPFN.
                  Follow the exact opening back to its employer.
                </p>
                <span>
                  A trained listing reader and a shortlist ranker connect to
                  source-based verification in one workspace.
                </span>
              </div>
            </div>
            <div className="pl-tech-grid">
              <article>
                <div className="pl-tech-brand">
                  <span className="pl-tech-glyph" aria-hidden="true">
                    t
                  </span>
                  <h3>Tinker</h3>
                </div>
                <h4>
                  Read the identity
                  <br />
                  inside the listing.
                </h4>
                <p>
                  A specialized extractor for employer, role, posting ID and ATS
                  references in messy advertisement text.
                </p>
                <span className="pl-tech-role">EXTRACTION</span>
              </article>
              <article>
                <div className="pl-tech-brand">
                  <span className="pl-tech-glyph" aria-hidden="true">
                    ↗
                  </span>
                  <h3>TabPFN</h3>
                </div>
                <h4>
                  Spend attention
                  <br />
                  where it matters.
                </h4>
                <p>
                  Structured prediction to rank which advertisements need
                  checking first, using only information available before
                  verification.
                </p>
                <span className="pl-tech-role">PRIORITIZATION</span>
              </article>
              <article>
                <div className="pl-tech-brand">
                  <span className="pl-tech-glyph" aria-hidden="true">
                    r
                  </span>
                  <h3>Render</h3>
                </div>
                <h4>
                  Make the answer
                  <br />
                  easy to reach.
                </h4>
                <p>
                  Render hosts the frontend, investigation API and Python model
                  clients, so checking a job can fit into an applicant’s everyday
                  search.
                </p>
                <span className="pl-tech-role">DELIVERY</span>
              </article>
            </div>
            <p className="pl-engine-note">
              The current verifier uses Mastra’s workflow layer. Optional
              Temporal execution preserves a check through worker interruptions.
            </p>
          </div>
        </section>
        <section
          className="pl-final pl-container"
          aria-labelledby="start-title"
        >
          <div>
            <p className="pl-eyebrow">BEFORE YOUR NEXT APPLICATION</p>
            <h2 id="start-title">
              Give the opening
              <br />
              <em>a second look.</em>
            </h2>
          </div>
          <div>
            <p>
              One job link. A finding grounded in the original source. Then,
              your next move.
            </p>
            <button
              className="pl-button pl-button-dark"
              type="button"
              onClick={onStart}
            >
              Check a job <Arrow />
            </button>
          </div>
        </section>
      </main>
      <footer className="pl-footer pl-container">
        <span>vacancy autopsy</span>
        <p>More clarity. Fewer dead ends.</p>
        <a href="#product-main">Back to top ↑</a>
      </footer>
    </div>
  );
}
