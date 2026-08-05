name: Feature request
description: Suggest a feature for pi-agent-tree
labels: ["enhancement"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for the suggestion! Before opening, check the README and open
        issues — the idea may already exist or be planned.
  - type: textarea
    id: problem
    attributes:
      label: Problem / motivation
      description: What does this feature solve, and for whom?
    validations:
      required: true
  - type: textarea
    id: proposal
    attributes:
      label: Proposed behavior
      description: How should it work? Include config shapes or command syntax if relevant.
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives
      description: What have you tried or considered instead?
