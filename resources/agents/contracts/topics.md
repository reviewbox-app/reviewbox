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
            "single": {
              "version": 1,
              "profile": { "style": "essential", "instructions": "" },
              "content": {
                "body": "Explanation of the change.",
                "readingSeconds": 30,
                "references": [],
                "terms": []
              }
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

Use the supplied canonical anchors, never invent IDs. Topic and step IDs must be distinct. Cover all supplied changes or explain exclusions in the brief. Several steps may refer to one passage and a step may use multiple anchors. Write one document per step using the chosen writing profile. Legacy three-level documents remain readable, but new proposals use the single-document format. The application computes reading durations. Nothing in this response validates a step or file.

Step titles are concise navigation labels in the requested language: aim for 2–5
words, never more than 6, and preferably 40 characters or fewer. Name one concrete
behavior or change, without introductory filler or subtitles. Keep explanations
and consequences in the document body.
