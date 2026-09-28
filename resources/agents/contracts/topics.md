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
          "documents": {
            "beginner": {
              "body": "Plain-language explanation of the behavior.",
              "readingSeconds": 30,
              "references": [],
              "terms": []
            },
            "intermediate": {
              "body": "A technical explanation with definitions and pseudo-code.",
              "readingSeconds": 45,
              "references": [],
              "terms": []
            },
            "developer": {
              "body": "Technical choices and consequences, with captured references.",
              "readingSeconds": 60,
              "references": [],
              "terms": []
            }
          },
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

Use the supplied canonical anchors, never invent IDs. Topic and step IDs must be distinct. Cover all supplied changes or explain exclusions in the brief. Several steps may refer to one passage and a step may use multiple anchors. Step documents require all three distinct levels. See `resources/agents/preparation/documents.md` for the controlled reference, term and block vocabulary. The application computes reading durations. Nothing in this response validates a step or file.
