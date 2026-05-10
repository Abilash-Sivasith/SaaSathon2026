import Image from "next/image";

export default function Home() {
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Oblique home">
          <Image
            className="logo-icon"
            src="/assets/oblique-icon.png"
            width={40}
            height={40}
            alt="Oblique"
            priority
          />
        </a>
        <div className="topbar-right">
          <div className="user-chip" aria-label="Signed in user">
            <div className="user-avatar" aria-hidden="true">
              CA
            </div>
            <div className="user-meta">
              <div className="name">Cairo Akehurst</div>
              <div className="role">Signed in · Oblique</div>
            </div>
          </div>
        </div>
      </header>

      <section className="page-intro mb-section">
        <h1>Your week at a glance</h1>
        <p>
          Call analytics, follow-ups from your last meeting, and what is working
          across the org.
        </p>

        <div className="metrics" aria-label="Phone call analytics summary">
          <article className="metric-card">
            <div className="label">Calls (7d)</div>
            <div className="value">47</div>
            <div className="delta up">↑ 12% vs prior week</div>
          </article>
          <article className="metric-card">
            <div className="label">Avg. duration</div>
            <div className="value">28m</div>
            <div className="delta up">↑ 3m avg.</div>
          </article>
          <article className="metric-card">
            <div className="label">Connect rate</div>
            <div className="value">64%</div>
            <div className="delta down">↓ 2 pts</div>
          </article>
          <article className="metric-card">
            <div className="label">Next steps logged</div>
            <div className="value">38</div>
            <div className="delta up">↑ 9 new</div>
          </article>
        </div>

        <div
          className="metrics metrics--engagement"
          aria-label="Presence and delivery analytics"
        >
          <article className="metric-card">
            <div className="label">Smiling (last call)</div>
            <div className="value">76%</div>
            <div className="delta up">↑ vs your 30-day avg</div>
          </article>
          <article className="metric-card">
            <div className="label">Eye contact</div>
            <div className="value">58%</div>
            <div className="delta up">↑ camera-on segments</div>
          </article>
          <article className="metric-card">
            <div className="label">Talk speed</div>
            <div className="value">152</div>
            <div className="delta">words/min · in target band</div>
          </article>
        </div>

        <section
          className="panel upload-panel mb-section"
          aria-busy="true"
          aria-labelledby="upload-heading"
        >
          <div className="panel-body upload-panel-body">
            <div className="upload-panel-top">
              <Image
                className="logo-icon"
                src="/assets/oblique-icon.png"
                width={40}
                height={40}
                alt=""
                aria-hidden={true}
              />
              <div className="upload-copy">
                <h2 className="upload-heading" id="upload-heading">
                  Uploading latest footage
                </h2>
                <p className="upload-sub">
                  Front camera + screen capture from your last session — encoding
                  and syncing to Oblique.
                </p>
              </div>
            </div>
            <div
              className="load-track"
              role="progressbar"
              aria-label="Upload progress (demo)"
            >
              <div className="load-fill" />
            </div>
            <div className="upload-meta">
              <span>Almost there — optimizing for review</span>
              <span className="upload-meta-pct">~2:10 remaining</span>
            </div>
          </div>
        </section>
      </section>

      <div className="grid-main mb-section">
        <section className="panel" aria-labelledby="analytics-heading">
          <div className="panel-header">
            <div>
              <h2 id="analytics-heading">Outbound volume</h2>
              <div className="sub">Daily connected calls · this week</div>
            </div>
          </div>
          <div className="panel-body">
            <div
              className="chart-area"
              role="img"
              aria-label="Bar chart: call volume Mon through Sun"
            >
              <div className="bar" />
              <div className="bar" />
              <div className="bar" />
              <div className="bar" />
              <div className="bar" />
              <div className="bar" />
              <div className="bar" />
            </div>
            <div className="chart-labels">
              <span>Mon</span>
              <span>Sun</span>
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="next-steps-heading">
          <div className="panel-header">
            <div>
              <h2 id="next-steps-heading">Next steps · prospect call</h2>
              <div className="sub">
                Aligned to talk track: product, pricing, history, certs
              </div>
            </div>
          </div>
          <div className="panel-body">
            <ul className="next-list">
              <li>
                <span className="check done" aria-label="Completed" />
                <div>
                  <div className="next-title">
                    Send Oblique one-pager (sales training, real-time retrieval,
                    AI in workflow)
                  </div>
                  <div className="next-meta">
                    Only after they ask for new product detail · owner: you
                  </div>
                </div>
              </li>
              <li>
                <span className="check" aria-label="Not completed" />
                <div>
                  <div className="next-title">
                    Follow up on pricing: $100/user/mo; they asked 22% off — max
                    discount 30%
                  </div>
                  <div className="next-meta">
                    Confirm approvers if you move past list price
                  </div>
                </div>
              </li>
              <li>
                <span className="check" aria-label="Not completed" />
                <div>
                  <div className="next-title">
                    Certs &amp; compliance email: SOC 2 today; ISO 9001 target Q1
                    2027
                  </div>
                  <div className="next-meta">
                    Be ready for ISO 5055-style questions in the next live call
                  </div>
                </div>
              </li>
              <li>
                <span className="check" aria-label="Not completed" />
                <div>
                  <div className="next-title">
                    If reliability or “single cloud” comes up: restate
                    cloud-agnostic posture (2014 lesson)
                  </div>
                  <div className="next-meta">
                    Optional: share Integration Team case — $100k buy, renew 2027
                    at $200k
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </section>
      </div>

      <div className="two-col-bottom">
        <section className="panel" aria-labelledby="leaderboard-heading">
          <div className="panel-header">
            <div>
              <h2 id="leaderboard-heading">Company leaderboard</h2>
              <div className="sub">Qualified meetings booked · this quarter</div>
            </div>
          </div>
          <div className="panel-body" style={{ padding: 0 }}>
            <table className="leader-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Rep</th>
                  <th>Meetings</th>
                  <th>Win rate</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="rank gold">1</td>
                  <td>
                    <div className="rep">
                      <span
                        className="rep-av"
                        style={{ background: "#a78bfa" }}
                      >
                        AS
                      </span>
                      Abilash Sivasith
                    </div>
                  </td>
                  <td className="num">44</td>
                  <td className="num">40%</td>
                </tr>
                <tr>
                  <td className="rank silver">2</td>
                  <td>
                    <div className="rep">
                      <span
                        className="rep-av"
                        style={{ background: "#f472b6" }}
                      >
                        TT
                      </span>
                      Tony Tu
                    </div>
                  </td>
                  <td className="num">41</td>
                  <td className="num">37%</td>
                </tr>
                <tr>
                  <td className="rank bronze">3</td>
                  <td>
                    <div className="rep">
                      <span
                        className="rep-av"
                        style={{ background: "#4ade80" }}
                      >
                        OG
                      </span>
                      Oliver Garrett
                    </div>
                  </td>
                  <td className="num">35</td>
                  <td className="num">34%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel" aria-labelledby="learnings-heading">
          <div className="panel-header">
            <div>
              <h2 id="learnings-heading">Strategies &amp; learnings</h2>
              <div className="sub">Patterns from high-performing calls</div>
            </div>
          </div>
          <div className="panel-body">
            <div className="learnings-grid">
              <article className="learning-card">
                <div className="topic">Pricing</div>
                <h3>Customers are asking for a 22% discount</h3>
                <p>
                  List is $100 per user per month. Policy allows up to 30% off—so
                  22% is in band, but still document the ask and who approved it
                  before you commit in writing.
                </p>
                <div className="learning-footer">
                  From live call summaries · Oblique
                </div>
              </article>
              <article className="learning-card">
                <div className="topic">Objections &amp; queries</div>
                <h3>Buyers keep asking about ISO 5055</h3>
                <p>
                  Expect it on discovery and security reviews. Pair the answer
                  with what you can prove today (SOC 2) and what is on the
                  roadmap (e.g. ISO 9001 by Q1 2027) so the thread does not stall.
                </p>
                <div className="learning-footer">
                  Top recurring question this month
                </div>
              </article>
              <article className="learning-card">
                <div className="topic">Positioning</div>
                <h3>Customers want cloud-agnostic—say it again, every time</h3>
                <p>
                  When uptime or vendor lock-in comes up, restate that you are
                  cloud agnostic so a repeat of 2014-style single-cloud pain is
                  far less likely. Do not assume they heard it the first time.
                </p>
                <div className="learning-footer">
                  Repeat the line until it sticks
                </div>
              </article>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
