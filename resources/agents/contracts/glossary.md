# Glossary proposal contract

Return one JSON object:

```json
{
  "kind": "glossary",
  "terms": [
    {
      "id": "term-1",
      "term": "Name",
      "aliases": ["alias"],
      "archived": false,
      "senses": [{ "id": "sense-1", "description": "Meaning in this project" }]
    }
  ]
}
```

Use distinct temporary IDs for terms and meanings. One term may have several meanings; explain their contexts instead of choosing silently. Propose only meanings supported by the selected source. Accepting this proposal adds project meanings; it never overwrites existing local occurrence definitions.
