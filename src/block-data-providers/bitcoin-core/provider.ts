import { ConfigService } from '@nestjs/config';
import * as Client from 'bitcoin-core';
import { BitcoinCoreConfig } from '@/configuration.model';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { BitcoinNetwork } from '@/common/enum';
import { TAPROOT_ACTIVATION_HEIGHT } from '@/common/constants';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
    IndexerService,
    TransactionInput,
    TransactionOutput,
} from '@/indexer/indexer.service';
import { OperationStateService } from '@/operation-state/operation-state.service';
import { BaseBlockDataProvider } from '@/block-data-providers/base-block-data-provider.abstract';
import {
    Block,
    BitcoinCoreOperationState,
    BlockTransaction,
    Transaction,
    Input,
    isCoinbaseInput,
    Output,
} from '@/block-data-providers/bitcoin-core/interfaces';

@Injectable()
export class BitcoinCoreProvider
    extends BaseBlockDataProvider
    implements OnApplicationBootstrap
{
    protected readonly logger = new Logger(BitcoinCoreProvider.name);
    protected readonly operationStateKey = 'bitcoincore-operation-state';
    private isSyncing = false;

    public client: Client;

    public constructor(
        private configService: ConfigService,
        indexerService: IndexerService,
        operationStateService: OperationStateService,
    ) {
        super(indexerService, operationStateService);
        this.initializeClient();
    }

    initializeClient() {
        let network: string;
        switch (this.configService.get<BitcoinNetwork>('app.network')) {
            case BitcoinNetwork.TESTNET:
                network = 'testnet';
                break;
            case BitcoinNetwork.REGTEST:
                network = 'regtest';
                break;
            case BitcoinNetwork.MAINNET:
            default:
                network = 'mainnet';
        }
        const config = this.configService.get<BitcoinCoreConfig>('bitcoinCore');
        this.client = new Client({
            network,
            host: config.rpcHost,
            password: config.rpcPass,
            port: config.rpcPort,
            username: config.rpcUser,
        });
    }

    async onApplicationBootstrap() {
        const getState = await this.getState();
        if (getState) {
            this.logger.log(
                `Restoring state from previous run: ${JSON.stringify(
                    getState,
                )}`,
            );
        } else {
            this.logger.log('No previous state found. Starting from scratch.');
            const state: BitcoinCoreOperationState = {
                currentBlockHeight: 0,
                indexedBlockHeight:
                    this.configService.get<BitcoinNetwork>('app.network') ===
                    BitcoinNetwork.MAINNET
                        ? TAPROOT_ACTIVATION_HEIGHT - 1
                        : 0,
            };
            await this.setState(state);
        }
    }

    @Cron(CronExpression.EVERY_10_SECONDS)
    async sync() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        const state = await this.getState();
        if (!state) {
            throw new Error('State not found');
        }
        const tipHeight = await this.getTipHeight();
        if (tipHeight <= state.indexedBlockHeight) {
            this.logger.debug(
                `No new blocks found. Current tip height: ${tipHeight}`,
            );
            this.isSyncing = false;
            return;
        }

        let height = state.indexedBlockHeight + 1;

        for (height; height <= tipHeight; height++) {
            const transactions = await this.processBlock(height);
            for (const transaction of transactions) {
                const { txid, vin, vout, blockHeight, blockHash } = transaction;
                await this.indexTransaction(
                    txid,
                    vin,
                    vout,
                    blockHeight,
                    blockHash,
                );
            }
            state.indexedBlockHeight = height;
            await this.setState(state);
        }
        this.isSyncing = false;
    }

    protected async getTipHeight(): Promise<number> {
        try {
            return await this.client.getBlockCount();
        } catch (error) {
            this.logger.log(`Error fetching block count`);
            throw error;
        }
    }

    protected async getBlockHash(height: number): Promise<string> {
        try {
            return await this.client.getBlockHash(height);
        } catch (error) {
            this.logger.log(`Error fetching  block hash of height : ${height}`);
            throw error;
        }
    }

    protected async getBlock(hash: string, verbosity: number): Promise<Block> {
        try {
            return await this.client.getBlock(hash, verbosity);
        } catch (error) {
            this.logger.log(`Error fetching block with block hash : ${hash}`);
            throw error;
        }
    }

    protected async getRawTransaction(
        txid: string,
        isVerbose: boolean,
    ): Promise<BlockTransaction> {
        try {
            return await this.client.getRawTransaction(txid, isVerbose);
        } catch (error) {
            this.logger.log(
                `Error fetching transaction with transaction id : ${txid}`,
            );
            throw error;
        }
    }

    public async processBlock(height: number): Promise<Transaction[]> {
        const parsedTransactionList: Transaction[] = [];
        const blockHash = await this.getBlockHash(height);
        this.logger.log(
            `Processing block at height ${height}, hash ${blockHash}`,
        );
        const block = await this.getBlock(blockHash, 2);
        for (const txn of block.tx) {
            const parsedTransaction = await this.parseTransaction(
                txn,
                block.hash,
                block.height,
            );
            parsedTransactionList.push(parsedTransaction);
        }
        return parsedTransactionList;
    }

    private async parseTransaction(
        txn: BlockTransaction,
        blockHash: string,
        blockHeight: number,
    ): Promise<Transaction> {
        const inputs: TransactionInput[] = await Promise.all(
            txn.vin.map(
                async (input) => await this.parseTransactionInput(input),
            ),
        );
        const outputs: TransactionOutput[] = txn.vout.map((output) =>
            this.parseTransactionOutput(output),
        );

        return {
            txid: txn.txid,
            vin: inputs,
            vout: outputs,
            blockHeight,
            blockHash,
        };
    }

    private async parseTransactionInput(
        txnInput: Input,
    ): Promise<TransactionInput> {
        let txid =
            '0000000000000000000000000000000000000000000000000000000000000000';
        let vout = 0;
        let prevOutScript = '';
        let witness = undefined;
        let scriptSig = '';

        if (!isCoinbaseInput(txnInput)) {
            txid = txnInput.txid;
            const prevTransaction = await this.getRawTransaction(
                txnInput.txid,
                true,
            );
            vout = txnInput.vout;
            prevOutScript = prevTransaction.vout.find((out) => out.n == vout)
                .scriptPubKey.hex;
            witness = txnInput.txinwitness;
            scriptSig = txnInput.scriptSig.hex;
        }

        return {
            txid,
            vout,
            scriptSig,
            witness,
            prevOutScript,
        };
    }

    private parseTransactionOutput(txnOutput: Output): TransactionOutput {
        return {
            scriptPubKey: txnOutput.scriptPubKey.hex,
            value: txnOutput.value,
        };
    }
}
