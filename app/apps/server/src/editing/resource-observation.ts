/** Synchronous primitive observers only. Resource owners call changed() after EACH mutation;
 * observers update numeric peaks, never write logs or await while SQL fences are held. */
const observers=new Set<()=>void>();
export function observeEditingResources(observer:()=>void) {
  if(observers.size>=4)throw new Error('The bounded editing resource observer set is full');
  observers.add(observer);return()=>{observers.delete(observer);};
}
export function editingResourcesChanged(){for(const observer of observers)observer();}
