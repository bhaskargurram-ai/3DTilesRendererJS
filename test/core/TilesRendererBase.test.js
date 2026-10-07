import {
	TilesRendererBase,
	LRUCache,
	PriorityQueue,
	DownloadPriorityQueue,
	UNLOADED,
	QUEUED,
	LOADING,
	LOADED,
} from '../../src/core/renderer';

const nextFrame = () => new Promise( resolve => requestAnimationFrame( resolve ) );

// creates a renderer with its own cache and queues and a plugin that keeps every download pending
// until its abort signal fires
function createPendingDownloadRenderer() {

	const renderer = new TilesRendererBase();
	renderer.lruCache = new LRUCache();
	renderer.downloadQueue = new DownloadPriorityQueue();
	renderer.parseQueue = new PriorityQueue();

	const signals = [];
	renderer.registerPlugin( {
		fetchData( url, { signal } ) {

			signals.push( signal );
			return new Promise( ( resolve, reject ) => {

				signal.addEventListener( 'abort', () => reject( new DOMException( 'Aborted', 'AbortError' ) ) );

			} );

		},
	} );

	return { renderer, signals };

}

// mimics a traversal in "update" that no longer uses any of the tiles in the cache
function removeAfterUnusedTraversal( renderer ) {

	renderer.lruCache.markAllUnused();
	renderer.removeUnusedPendingTiles();

}

function createTile( renderer, uri ) {

	const tile = { geometricError: 1, content: { uri } };
	renderer.preprocessNode( tile, 'https://example.com' );
	return tile;

}

describe( 'TilesRendererBase', () => {

	it( 'should count tiles refused by a full cache in stats.refused', () => {

		const renderer = new TilesRendererBase();
		renderer.lruCache = new LRUCache();
		renderer.lruCache.maxSize = 0;

		const tile = { internal: { loadingState: UNLOADED } };
		renderer.queueTileForDownload( tile );
		renderer.queueTileForDownload( tile );
		renderer.queueTileForDownload( { internal: { loadingState: UNLOADED } } );
		renderer.queueTileForDownload( { internal: { loadingState: LOADED } } );

		expect( renderer.stats.refused ).toBe( 2 );
		expect( renderer.queuedTiles ).toHaveLength( 0 );

	} );

	it( 'should only queue a tile once per update', () => {

		const renderer = new TilesRendererBase();
		renderer.lruCache = new LRUCache();

		const tile = { internal: { loadingState: UNLOADED } };
		renderer.queueTileForDownload( tile );
		renderer.queueTileForDownload( tile );

		expect( renderer.queuedTiles ).toHaveLength( 1 );
		expect( renderer.stats.refused ).toBe( 0 );

	} );

	describe( 'removeUnusedPendingTiles', () => {

		it( 'should remove unused queued tiles', () => {

			const { renderer, signals } = createPendingDownloadRenderer();
			const tile = createTile( renderer, 'tile.b3dm' );
			renderer.requestTileContents( tile );

			expect( tile.internal.loadingState ).toBe( QUEUED );
			expect( renderer.stats.queued ).toBe( 1 );

			removeAfterUnusedTraversal( renderer );

			expect( tile.internal.loadingState ).toBe( UNLOADED );
			expect( renderer.stats.queued ).toBe( 0 );
			expect( renderer.downloadQueue.has( tile ) ).toBe( false );
			expect( signals ).toHaveLength( 0 );

		} );

		it( 'should not cancel unused tiles that are downloading by default', async () => {

			const { renderer, signals } = createPendingDownloadRenderer();
			const tile = createTile( renderer, 'tile.b3dm' );
			renderer.requestTileContents( tile );
			await nextFrame();

			expect( tile.internal.loadingState ).toBe( LOADING );
			expect( renderer.stats.downloading ).toBe( 1 );

			removeAfterUnusedTraversal( renderer );

			expect( tile.internal.loadingState ).toBe( LOADING );
			expect( renderer.stats.downloading ).toBe( 1 );
			expect( signals[ 0 ].aborted ).toBe( false );

		} );

		it( 'should cancel unused tiles that are downloading if "cancelUnusedDownloads" is set', async () => {

			const { renderer, signals } = createPendingDownloadRenderer();
			renderer.cancelUnusedDownloads = true;

			const tile = createTile( renderer, 'tile.b3dm' );
			renderer.requestTileContents( tile );
			await nextFrame();

			expect( tile.internal.loadingState ).toBe( LOADING );
			expect( renderer.downloadQueue.running ).toBe( true );

			removeAfterUnusedTraversal( renderer );

			expect( tile.internal.loadingState ).toBe( UNLOADED );
			expect( renderer.stats.downloading ).toBe( 0 );
			expect( renderer.stats.inCache ).toBe( 0 );
			expect( renderer.loadingTiles.has( tile ) ).toBe( false );
			expect( signals[ 0 ].aborted ).toBe( true );

			// the canceled request should free up its download slot
			await nextFrame();
			expect( renderer.downloadQueue.running ).toBe( false );

		} );

		it( 'should not cancel downloading tiles that are still used', async () => {

			const { renderer, signals } = createPendingDownloadRenderer();
			renderer.cancelUnusedDownloads = true;

			const tile = createTile( renderer, 'tile.b3dm' );
			renderer.requestTileContents( tile );
			await nextFrame();

			renderer.lruCache.markAllUnused();
			renderer.markTileUsed( tile );
			renderer.removeUnusedPendingTiles();

			expect( tile.internal.loadingState ).toBe( LOADING );
			expect( renderer.stats.downloading ).toBe( 1 );
			expect( signals[ 0 ].aborted ).toBe( false );

		} );

	} );

	it( 'should unregister plugin by name', () => {

		const renderer = new TilesRendererBase();

		renderer.registerPlugin( { name: 'test' } );

		expect( renderer.unregisterPlugin( 'test' ) ).toBe( true );

	} );

	it( 'should preprocess newly appended children even if earlier children were already processed', () => {

		const renderer = new TilesRendererBase();
		const processedChild = { children: [] };
		const unprocessedChild = { children: [] };
		const parent = {
			children: [ processedChild, unprocessedChild ],
		};

		renderer.preprocessNode( parent, '', null );
		renderer.preprocessNode( processedChild, '', parent );

		expect( processedChild.traversal ).toBeDefined();
		expect( unprocessedChild.traversal ).toBeUndefined();

		renderer.ensureChildrenArePreprocessed( parent, true );

		expect( unprocessedChild.traversal ).toBeDefined();
		expect( unprocessedChild.parent ).toBe( parent );

	} );

} );
