import { SlashCommandNumberOption, SlashCommandStringOption } from 'discord.js';

export const watchTypeOptions = (option: SlashCommandStringOption) =>
	option
		.setName('type')
		.setDescription('the type of auction to watch')
		.addChoices(
			{ name: 'WTS', value: 'WTS' },
			{ name: 'WTB', value: 'WTB' },
		)
		.setRequired(true);

export const itemNameOptions = (option: SlashCommandStringOption) =>
	option
		.setName('item')
		.setDescription('the name of the item you want to watch')
		.setRequired(true);

export const serverOptions = (option: SlashCommandStringOption) =>
	option
		.setName('server')
		.setDescription('select a server')
		.addChoices(
			{ name: 'blue server', value: 'BLUE' },
			{ name: 'green server', value: 'GREEN' },
			{ name: 'red server', value: 'RED' },
		)
		.setRequired(true);

export const priceCriteriaOptions = (option: SlashCommandNumberOption) =>
	option.setName('price').setDescription('enter optional price criteria');
