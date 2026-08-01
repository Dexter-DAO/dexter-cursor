console.error(
  "Direct package release is disabled. Use the coordinated OpenDexter release "
    + "train so the exact package tree, dependencies, registry install, and "
    + "distribution manifests are verified together. Prereleases must publish "
    + "with the explicitly approved dist-tag.",
);
process.exitCode = 1;
