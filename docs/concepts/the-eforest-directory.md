---
title: The .eforest directory
section: Concepts
order: 4
summary: The task queue, the loop, and the evidence — the future and the proof.
---

# The `.eforest` directory

`.git` stores the history of file changes. `.eforest` stores the **future of what we are
doing and the history of what we have done**: the task queue is the future, the
verification logs and evidence folders are the past, and `loop.md` is the machine that
turns one into the other.

```
.eforest/
  loop.md                the builder / critic / progress-critic contract
  project.json           building · complete · paused · invalid_loop
  tasks/
    QUEUE.md             generated priority queue — never edited by hand
    README.md            task folder anatomy and queue rules
    epic-5-the-meadow/
      E5-T14-visual-product-capstone/
        readme.md        the spec, the claim, and the verification log
        evidence/        committed proof: digests, dumps, Replay runs
        work/            the builder's scratch space (gitignored)
```

## A task is a folder

The only required file is `readme.md`. Its frontmatter is the task's state:

```yaml
---
id: E5-T14
epic: 5
title: "Capstone: the meadow as a polished code host"
priority: 514
status: verified
depends_on: [E5-T13]
estimate: L
capstone: true
---
```

- `priority` is `epic × 100 + task number`; the queue is sorted ascending.
- `depends_on` may name tasks or bare epics (`E1` means "that epic's capstone is verified").
- `status` moves `pending → in-progress → implemented → verified`, with `refuted` sending
  it back to work. **Only an adversarial critic sets `verified`.**

Regenerate the queue after any frontmatter change:

```sh
python3 tools/build_queue.py
```

{% hint style="info" %}
The [roadmap page](/roadmap) on this site is that same board: every task is indexed from
`.eforest/tasks/` at build time and its readme is rendered on demand with Docstream.
{% endhint %}

## Project states

| State          | Meaning                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| `building`     | the loop is running: pick top eligible task → build → claim → verify       |
| `complete`     | every task is verified                                                     |
| `paused`       | a human paused the loop; it never self-resumes                             |
| `invalid_loop` | the loop caught itself death-spiraling and stopped; a human must intervene |

## This is also a product

Epic 6 turns this contract into product code: a task is an issue with evidence, on the
same unified stream model as everything else, and a hosted project's builder/critic loop
executes tasks end-to-end with statuses streaming live to the project page. Epic 8 closes
the circle — electric-forest hosts its own source and a task on itself reaches
`verified` entirely through the platform, with no git.
