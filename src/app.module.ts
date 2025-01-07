import { Module } from '@nestjs/common';
import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import configuration from '@/configuration';
import { TransactionsModule } from '@/transactions/transactions.module';
import { SilentBlocksModule } from '@/silent-blocks/silent-blocks.module';
import { OperationStateModule } from '@/operation-state/operation-state.module';
import { ScheduleModule } from '@nestjs/schedule';
import { BlockProviderModule } from '@/block-data-providers/block-provider.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TransactionOutputService } from './transaction-output/transaction-output.service';
import { TransactionOutputModule } from './transaction-output/transaction-output.module';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        EventEmitterModule.forRoot(),
        ConfigModule.forRoot({
            ignoreEnvFile: true,
            load: [configuration],
            isGlobal: true,
        }),
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => ({
                type: 'sqlite',
                database: configService.get<string>('db.path'),
                synchronize: configService.get<boolean>('db.synchronize'),
                autoLoadEntities: true,
            }),
        }),
        TransactionsModule,
        SilentBlocksModule,
        OperationStateModule,
        BlockProviderModule,
        TransactionOutputModule,
    ],
    controllers: [AppController],
    providers: [AppService, TransactionOutputService],
})
export class AppModule {}
