Naebka Frontend
===============

Context
-------

The frontend of **naebka.win** is intended to provide a modern, responsive,
and consistent experience for a web-based gaming platform. The initial focus
is a casino-style game, but the frontend should be designed to accommodate
additional games and shared platform features over time.

The objective is to build a maintainable, extensible frontend without
introducing unnecessary complexity. Shared UI patterns should remain
consistent, while each game retains the flexibility to implement its own
interactions and visual identity.

Technology Stack
----------------

`Vite+ <https://www.viteplus.dev/>`_
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Unified development toolchain for the web.**

Vite+ is the project's development toolchain, not its UI framework. It brings
development, building, testing, linting, formatting, and related checks into a
more consistent workflow.

The main reasons for choosing Vite+ are:

* **Unified tooling:** Reduces the need to configure and maintain separate
  commands and conventions for common development tasks.
* **Fast feedback:** Builds on the Vite ecosystem for a responsive local
  development experience and Hot Module Replacement (HMR).
* **Code quality:** Provides an integrated approach to linting, formatting,
  testing, and checking code.
* **Framework flexibility:** Works with SolidJS without tying the frontend
  architecture to a particular UI framework.
* **Room to grow:** Can support additional packages and more structured
  workflows as the project expands.

For naebka.win, Vite+ helps the team spend less time maintaining tooling and
more time implementing and validating frontend features.

Further reading: `Why Vite+? <https://www.viteplus.dev/guide/why>`_

`SolidJS <https://www.solidjs.com/>`_
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Reactive UI framework.**

SolidJS is used to build the frontend interface. Its fine-grained reactivity
updates the parts of the DOM affected by state changes without relying on
Virtual DOM reconciliation. This is useful for interactive interfaces with
frequently changing state.

The main reasons for choosing SolidJS are:

* **Fine-grained reactivity:** Keeps UI updates targeted and predictable.
* **Performance:** Supports responsive interactions with low rendering
  overhead.
* **Component composition:** Makes it possible to separate shared interface
  elements from game-specific components.
* **TypeScript integration:** Supports strongly typed components and APIs.
* **Vite ecosystem compatibility:** Fits the chosen development toolchain.

For naebka.win, SolidJS provides a foundation for game controls, dynamic
status displays, navigation, and reusable platform components.

Further reading: `SolidJS documentation <https://docs.solidjs.com/>`_

`TypeScript <https://www.typescriptlang.org/>`_
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**JavaScript with syntax for types.**

TypeScript is used to make component contracts, application state, and API
data structures explicit. Static type checking helps detect integration
mistakes earlier and supports refactoring as the codebase grows.

`Tailwind CSS <https://tailwindcss.com/>`_
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Utility-first styling framework.**

Tailwind CSS is used to build responsive layouts and maintain consistent
visual styling. Common design decisions, such as spacing, typography, and
colors, should be expressed through reusable components and shared design
tokens rather than repeated ad hoc styles.

`TanStack <https://tanstack.com/>`_ tools
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Focused libraries for application infrastructure.**

Relevant TanStack libraries can be used for routing, server-state management,
and other needs as they arise. Individual tools should be adopted for a clear
purpose, rather than added by default.

`openapi-typescript <https://openapi-ts.dev/>`_
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Types generated from OpenAPI specifications.**

openapi-typescript helps keep frontend API types aligned with backend
contracts. Generated types reduce duplicated definitions and make API
integration changes easier to identify.

`dnd-kit <https://dndkit.com/>`_
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Drag-and-drop interaction toolkit.**

dnd-kit may be used for features that require drag-and-drop interactions.
It is not a general dependency for every game or screen.

Custom Component Registry
~~~~~~~~~~~~~~~~~~~~~~~~~

**Reusable, internally maintained UI components.**

A custom component registry provides a consistent source for shared
components and interaction patterns. It should help standardize the interface
without preventing individual games from having distinct designs.

Frontend Architecture and Design Direction
------------------------------------------

The frontend should be organized around clear boundaries between shared
platform functionality and individual games. The initial implementation does
not assume a subdomain-based architecture or independent deployments for each
game. Routing and deployment can be revisited when project requirements make
that necessary.

The UI should follow these principles:

* **Consistency:** Shared typography, spacing, colors, navigation, and
  interaction patterns.
* **Responsiveness:** Interfaces that work across desktop and mobile screens.
* **Accessibility:** Semantic elements, keyboard support, and clear feedback
  where applicable.
* **Performance:** Responsive interactions and mindful loading of game-specific
  functionality.
* **Modularity:** Reusable platform components with appropriately isolated
  game-specific logic.
* **Pragmatism:** Abstractions and dependencies should address actual needs.

Methodology Position
--------------------

The technology stack describes *what* will be used to implement the frontend;
it does not, by itself, define *how* the work will be organized.

I intend to develop and document a frontend development methodology suited to
the project and team. Rather than immediately committing to a named process
such as Scrum, Kanban, or Waterfall, I will evaluate useful practices and
adapt them based on development experience, feedback, and project constraints.

Principles Guiding the Methodology
----------------------------------

* **Incremental delivery:** Implement small, demonstrable frontend features.
* **Clear coordination:** Agree on interfaces and responsibilities with other
  team members, especially for backend and API integration.
* **Maintainable implementation:** Favor typed contracts, reusable UI
  components, and understandable code organization.
* **Verification:** Use appropriate checks, testing, and review before
  considering changes complete.
* **Documentation:** Record meaningful architecture and workflow decisions.
* **Adaptability:** Revise practices when there is evidence that another
  approach works better.

Current Status and Next Steps
-----------------------------

This document records the current frontend technology and design direction,
not a finalized development methodology. As implementation progresses, I will
document the practices actually used for planning, task management, code
review, testing, integration, and release readiness.

The resulting methodology will be refined through practical experience and
evaluated against the team's ability to deliver reliable frontend features
consistently.
