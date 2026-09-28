// Maintenance-only: resolve and pin the Ruby LSP gem graph from RubyGems.
export {}
const constraints = new Map<string, string[]>([["ruby-lsp", ["= 0.26.11"]]])
const metadata = new Map<
  string,
  {
    name: string
    version: string
    sha: string
    dependencies: { runtime: { name: string; requirements: string }[] }
  }
>()
const range = (requirement: string) =>
  requirement
    .split(",")
    .map((part) => {
      const value = part.trim()
      if (!value.startsWith("~>")) return value.replace(/^=\s*/, "")
      const version = value.slice(2).trim()
      const components = version.split(".").map(Number)
      const upper =
        components.length < 3
          ? `${components[0] + 1}.0.0`
          : `${components[0]}.${components[1] + 1}.0`
      return `>=${version} <${upper}`
    })
    .join(" ")
const fetchJson = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`RubyGems returned ${response.status}: ${url}`)
  return response.json()
}
for (let pass = 0; pass < 10; pass++) {
  let changed = false
  for (const [name, requirements] of constraints) {
    const versions = (await fetchJson(
      `https://rubygems.org/api/v1/versions/${name}.json`
    )) as {
      number: string
      platform: string
      prerelease: boolean
      ruby_version: string
    }[]
    const candidate = versions.find(
      (version) =>
        version.platform === "ruby" &&
        !version.prerelease &&
        requirements.every((required) =>
          Bun.semver.satisfies(version.number, range(required))
        ) &&
        Bun.semver.satisfies("3.4.11", range(version.ruby_version))
    )
    if (!candidate) throw new Error(`No compatible pinned Ruby gem: ${name}`)
    if (metadata.get(name)?.version === candidate.number) continue
    const info = await fetchJson(
      `https://rubygems.org/api/v2/rubygems/${name}/versions/${candidate.number}.json?platform=ruby`
    )
    metadata.set(name, info)
    for (const dependency of info.dependencies.runtime) {
      const previous = constraints.get(dependency.name) ?? []
      if (!previous.includes(dependency.requirements))
        constraints.set(dependency.name, [...previous, dependency.requirements])
    }
    changed = true
  }
  if (!changed) break
  if (pass === 9) throw new Error("Ruby dependency resolution did not converge")
}
const gems = [...metadata.values()].map((gem) => ({
  name: gem.name,
  version: gem.version,
  sha256: gem.sha,
  url: `https://rubygems.org/downloads/${gem.name}-${gem.version}.gem`,
}))
await Bun.write(
  "resources/languages/ruby-gems.json",
  JSON.stringify(gems, null, 2) + "\n"
)
console.info(`Pinned ${gems.length} Ruby LSP gems`)
