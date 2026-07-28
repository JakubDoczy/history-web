<script setup lang="ts">
</script>

<template>
  <header>
    <nav>
      <RouterLink to="/">Home</RouterLink>
    </nav>
  </header>
  <main>
    <RouterView />
  </main>
</template>

<style>
body {
  margin: 0;
  font-family: system-ui, sans-serif;
}
</style>
