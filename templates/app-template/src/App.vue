<script setup lang="ts">
// Tiny list UI over the in-memory store. Follows the host's color scheme via
// the `data-theme` attribute the shell sets on <html> (the dev shim mirrors
// the OS preference), so no theme plumbing is needed here.
import { onMounted, onUnmounted, ref } from "vue";
import { getItem, getSelectedId, listItems, onSelect, openItem } from "./store";

const items = listItems();
const selectedId = ref<string | null>(getSelectedId());

let unsubscribe: (() => void) | undefined;
onMounted(() => {
  unsubscribe = onSelect((id) => {
    selectedId.value = id;
  });
});
onUnmounted(() => unsubscribe?.());

const selected = () => (selectedId.value ? getItem(selectedId.value) : undefined);
</script>

<template>
  <div style="display: flex; gap: 1rem; padding: 1rem; font-family: system-ui, sans-serif">
    <ul style="list-style: none; margin: 0; padding: 0; min-width: 16rem">
      <li v-for="item in items" :key="item.id">
        <button
          type="button"
          style="display: block; width: 100%; text-align: left; padding: 0.4rem 0.6rem; background: none; border: none; cursor: pointer"
          :style="item.id === selectedId ? 'font-weight: 600' : ''"
          @click="openItem(item.id)"
        >
          {{ item.title }}
        </button>
      </li>
    </ul>
    <main style="flex: 1">
      <template v-if="selected()">
        <h1 style="margin-top: 0">{{ selected()!.title }}</h1>
        <p>{{ selected()!.preview }}</p>
      </template>
      <p v-else style="opacity: 0.6">Select an item — or find one via cross-app search.</p>
    </main>
  </div>
</template>
