# Topic proposal contract

Return one JSON object, with no surrounding commentary or additional properties:

```json
{
  "kind": "topics",
  "topics": [
    {
      "id": "topic-1",
      "title": "Topic title",
      "brief": "Purpose, expected behavior, risks, uncertainties",
      "steps": [
        {
          "id": "step-1",
          "title": "Step title",
          "explanation": "Explain this change",
          "anchors": [
            {
              "snapshotId": "exact supplied snapshot ID",
              "changeId": "exact supplied change ID",
              "passageId": "exact supplied passage ID"
            }
          ]
        }
      ]
    }
  ]
}
```

Use the supplied canonical anchors, never invent IDs. Topic and step IDs must be distinct. Cover all supplied changes or explain exclusions in the brief. Several steps may refer to one passage and a step may use multiple anchors. Nothing in this response validates code or resolves a human question.
